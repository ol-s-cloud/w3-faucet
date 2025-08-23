import { query } from "@w3/shared/db";
import { ethers } from "ethers";
import { retryRpc } from "@w3/shared/retry";
import { requireEnv, getIntEnv } from "@w3/shared/env";
import { redis } from "@w3/shared/redis";
import { randHex } from "@w3/shared/utils";

const RPC      = requireEnv("SEPOLIA_RPC_URL");
const CHAIN_ID = getIntEnv("CHAIN_ID", 11155111);
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);

// Tunables
const BATCH       = getIntEnv("RECONCILE_BATCH", 200);
const MAX_LOOPS   = getIntEnv("RECONCILE_MAX_LOOPS", 20);
const LOCK_TTL_MS = getIntEnv("RECONCILE_LOCK_TTL_MS", 55_000);
const LOCK_KEY    = "reconciler:lock";

// Safe unlock (only owner token releases)
const UNLOCK_LUA = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

async function tryAcquireLock(key: string, ttlMs: number): Promise<string | null> {
  const token = randHex(8);
  const res = await redis.set(key, token, "NX", "PX", ttlMs);
  return res === "OK" ? token : null;
}
async function releaseLock(key: string, token: string) {
  try { await redis.eval(UNLOCK_LUA, 1, key, token); } catch {}
}

export async function reconcileBroadcastsOnce() {
  let loops = 0;
  while (loops++ < MAX_LOOPS) {
    const { rows } = await query<{ id: number; tx_hash: string }>(
      "SELECT id, tx_hash FROM requests WHERE status='broadcast' ORDER BY created_at ASC LIMIT $1",
      [BATCH]
    );
    if (rows.length === 0) break;

    for (const r of rows) {
      if (!r.tx_hash) {
        await query(
          "UPDATE requests SET status='failed', reason=$1 WHERE id=$2",
          ["missing tx_hash in broadcast state", r.id]
        );
        continue;
      }

      try {
        const rcpt = await retryRpc(() => provider.getTransactionReceipt(r.tx_hash));
        if (!rcpt) continue; // still pending

        if (rcpt.status === 1) {
          await query("UPDATE requests SET status='sent' WHERE id=$1", [r.id]);
        } else if (rcpt.status === 0) {
          await query(
            "UPDATE requests SET status='failed', reason=$1 WHERE id=$2",
            ["transaction reverted", r.id]
          );
        } else {
          console.warn(`reconciler: unexpected receipt.status for id=${r.id} tx=${r.tx_hash}`);
        }
      } catch (e: any) {
        console.error(`reconciler: provider error for id=${r.id} tx=${r.tx_hash}:`, e?.message || e);
      }
    }

    if (rows.length < BATCH) break;
  }
}

export async function reconcileBroadcastsWithLock() {
  const token = await tryAcquireLock(LOCK_KEY, LOCK_TTL_MS);
  if (!token) {
    console.log("reconciler: skipped (lock held)");
    try { await redis.incrby("reconciler:skips", 1); } catch {}
    return;
  }
  try {
    await reconcileBroadcastsOnce();
  } finally {
    await releaseLock(LOCK_KEY, token);
  }
}
