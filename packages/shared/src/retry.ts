// packages/shared/src/retry.ts

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function toCode(err: any): string {
  return String(err?.code ?? "").toUpperCase();
}
function toStatus(err: any): number {
  const s = err?.status ?? err?.response?.status;
  return Number.isFinite(s) ? Number(s) : NaN;
}
function toMsg(err: any): string {
  const raw = err?.message ?? err?.response?.data?.message ?? err?.body ?? err;
  return String(raw ?? "").toLowerCase();
}

/** Retry: network flaps, rate limits, transient 5xx. Fail fast otherwise. */
export function isRetryableError(error: any): boolean {
  const code = toCode(error);
  const status = toStatus(error);
  const msg = toMsg(error);

  // Network-ish
  if (code.includes("NETWORK") || code.includes("TIMEOUT")) return true;
  if (/ec?onn?(refused|reset)|timed?out|dns|socket|temporar|unreachable|network/i.test(msg)) return true;

  // HTTP status
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (status === 403 && /rate|quota|throttle|forbidden.*rate/.test(msg)) return true;

  return false;
}

/**
 * Retry an RPC call with exponential backoff + jitter.
 * - baseDelayMs * (2 ** attempt), jitter +10–25%, capped at 15s
 * - Fail fast on non-retryable errors (400/401/params/reverts)
 */
export async function retryRpc<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 500
): Promise<T> {
  const MAX_DELAY_MS = 15_000;
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const status = toStatus(err);
      const code = toCode(err);
      const msg  = toMsg(err);

      const failFast =
        status === 400 || status === 401 ||
        code.includes("CALL_EXCEPTION") || code.includes("UNPREDICTABLE_GAS_LIMIT") ||
        /revert|execution reverted|invalid argument|invalid address|insufficient funds|bad response/i.test(msg);

      if (failFast || attempt >= maxRetries || !isRetryableError(err)) throw err;

      const base = Math.min(baseDelayMs * (2 ** attempt), MAX_DELAY_MS);
      const jitterMult = 1.10 + Math.random() * 0.15; // 1.10–1.25
      const delay = Math.min(Math.floor(base * jitterMult), MAX_DELAY_MS);
      await sleep(delay);
      attempt++;
    }
  }
}
