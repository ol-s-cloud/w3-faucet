import { Worker } from "bullmq";
import { ethers } from "ethers";
import { retryRpc, isRetryableError } from "@w3/shared/retry";
import { query } from "@w3/shared/db";
import type { DripJob } from "@w3/shared/types";
import { requireEnv, getIntEnv, getNumberEnv } from "@w3/shared/env";
import { redis } from "@w3/shared/redis";
import { reconcileBroadcastsWithLock } from "./reconciler";

/* ── Env ───────────────────────────────────────────────────────────── */
const RPC                 = requireEnv("SEPOLIA_RPC_URL");
const KEY                 = requireEnv("FAUCET_PRIVATE_KEY");
const CHAIN_ID            = getIntEnv("CHAIN_ID", 11155111);
const DRIP_AMOUNT         = process.env.DRIP_AMOUNT_ETH || "0.02";
const QUEUE_NAME          = process.env.QUEUE_NAME || "drips";
requireEnv("REDIS_URL");

const TX_WAIT_TIMEOUT_MS  = getIntEnv("TX_WAIT_TIMEOUT_MS", 120_000);
const FALLBACK_GAS_LIMIT  = BigInt(process.env.FALLBACK_GAS_LIMIT ?? "21000");
const MAX_FEE_BUMP_MULT   = getNumberEnv("MAX_FEE_BUMP_MULT", 1.25);

/* ── Chain ─────────────────────────────────────────────────────────── */
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const wallet   = new ethers.Wallet(KEY, provider);
const sender   = wallet.address.toLowerCase();

/* ── Nonce lock (Redis) ─────────────────────────────────────────────── */
const lockKey = (s: string) => `nonce-lock:${s}`;
async function acquireLock(key: string, ttlSec = 15): Promise<boolean> {
  const res = await redis.set(key, "1", "NX", "EX", ttlSec);
  return res === "OK";
}
async function acquireLockWithBackoff(key: string, ttlSec = 15): Promise<boolean> {
  const maxAttempts = 4;
  let delay = 150;
  for (let i = 0; i < maxAttempts; i++) {
    if (await acquireLock(key, ttlSec)) return true;
    await new Promise(r => setTimeout(r, delay + Math.random() * 80));
    delay = Math.floor(delay * 1.5);
  }
  return false;
}
async function releaseLock(key: string) { try { await redis.del(key); } catch {} }

/* ── Helpers ────────────────────────────────────────────────────────── */
function bumpBig(x: bigint, mult: number): bigint {
  const m = Math.round(mult * 100);
  return (x * BigInt(m)) / 100n;
}
async function getFeeSuggestion() {
  const fee = await retryRpc(() => provider.getFeeData());
  const gasPrice = fee.gasPrice ?? 1n * 10n ** 9n; // 1 gwei floor
  const maxPrio  = fee.maxPriorityFeePerGas ?? gasPrice / 2n;
  const maxFee   = fee.maxFeePerGas ?? (gasPrice + maxPrio);
  return {
    maxPriorityFeePerGas: bumpBig(maxPrio, MAX_FEE_BUMP_MULT),
    maxFeePerGas:         bumpBig(maxFee,  MAX_FEE_BUMP_MULT),
    gasPrice:             bumpBig(gasPrice, MAX_FEE_BUMP_MULT),
  };
}
async function ensureBalanceCovers(amountWei: bigint, feeWei: bigint) {
  const bal = await retryRpc(() => provider.getBalance(sender));
  if (bal < amountWei + feeWei) throw new Error("insufficient funds in faucet wallet for amount+fees");
}
function isPermanentError(err: any): boolean {
  const code = String(err?.code ?? "").toUpperCase();
  const status = Number(err?.status);
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  return (
    status === 400 || status === 401 ||
    code.includes("CALL_EXCEPTION") || code.includes("UNPREDICTABLE_GAS_LIMIT") ||
    /revert|execution reverted|invalid argument|invalid address|insufficient funds/i.test(msg)
  );
}
function formatReason(err: any): string {
  const msg = String(err?.message ?? err ?? "");
  return msg.slice(0, 400);
}

/* ── Worker ─────────────────────────────────────────────────────────── */
export const worker = new Worker<DripJob>(
  QUEUE_NAME,
  async (job) => {
    const { requestId, address } = job.data;

    if (!ethers.isAddress(address)) {
      await query("UPDATE requests SET status='failed', reason=$1 WHERE id=$2", ["invalid recipient address", requestId]);
      return;
    }

    const lk = lockKey(sender);
    const got = await acquireLockWithBackoff(lk, 15);
    if (!got) throw new Error("nonce lock not acquired (backoff exhausted)");

    try {
      const amountWei = ethers.parseEther(DRIP_AMOUNT);

      let gasLimit: bigint;
      try {
        gasLimit = await retryRpc(() => wallet.estimateGas({ to: address, value: amountWei }));
      } catch { gasLimit = FALLBACK_GAS_LIMIT; }

      const { maxFeePerGas } = await getFeeSuggestion();
      const effectiveFeePerGas = maxFeePerGas; // we use EIP-1559; Sepolia supports it
      const feeCost = effectiveFeePerGas * gasLimit;
      await ensureBalanceCovers(amountWei, feeCost);

      const tx = await retryRpc(() => wallet.sendTransaction({
        to: address,
        value: amountWei,
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas: undefined, // optional: set if you also compute it above
      }));

      await query("UPDATE requests SET status='broadcast', tx_hash=$1 WHERE id=$2", [tx.hash, requestId]);

      try {
        await retryRpc(() => provider.waitForTransaction(tx.hash, 1, TX_WAIT_TIMEOUT_MS));
        await query("UPDATE requests SET status='sent' WHERE id=$1 AND tx_hash=$2", [requestId, tx.hash]);
        console.log(`✅ Dripped ${DRIP_AMOUNT} ETH → ${address} (tx=${tx.hash})`);
        return;
      } catch (e: any) {
        const msg = String(e?.message ?? "").toLowerCase();
        if (msg.includes("timeout")) {
          console.warn(`⏱️ wait timeout; leaving as 'broadcast' (tx=${tx.hash})`);
          return; // reconciler will resolve later
        }
        throw e;
      }
    } catch (err: any) {
      const reason = formatReason(err);
      await query("UPDATE requests SET status='failed', reason=$1 WHERE id=$2", [reason, requestId]);

      if (isPermanentError(err)) { console.error(`⛔ Permanent: ${reason}`); return; }
      if (!isRetryableError(err)) { console.error(`⛔ Non-retryable: ${reason}`); return; }
      console.error(`🔁 Retryable: ${reason}`);
      throw err;
    } finally {
      await releaseLock(lk);
    }
  },
  {
    connection: { url: requireEnv("REDIS_URL") },
    concurrency: 2
  }
);

/* ── Reconciler ticker (no overlap; see reconciler.ts) ─────────────── */
const RECONCILE_INTERVAL_MS = getIntEnv("RECONCILE_INTERVAL_MS", 60_000);
setInterval(() => {
  reconcileBroadcastsWithLock().catch((e) =>
    console.error("reconciler run error:", e?.message || e)
  );
}, RECONCILE_INTERVAL_MS);

worker.on("completed", (job) => console.log(`Job ${job.id} completed ✅`));
worker.on("failed",    (job, err) => console.error(`Job ${job?.id} failed ❌ ${err?.message || err}`));
