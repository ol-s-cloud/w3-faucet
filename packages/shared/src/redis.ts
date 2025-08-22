// packages/shared/src/redis.ts
import IORedis from "ioredis";

/**
 * REDIS_URL must be set in API & Worker environments.
 * Example: redis://default:password@host:6379/0
 */
const REDIS_URL = process.env.REDIS_URL!;
if (!REDIS_URL) {
  throw new Error("REDIS_URL is not set");
}

/**
 * ioredis is BullMQ's preferred client.
 * `maxRetriesPerRequest: null` prevents command timeouts inside BullMQ.
 */
export const redis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

/**
 * Health probe.
 * Can be used in /health or readiness checks.
 */
export async function redisHealthcheck(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Graceful shutdown.
 * Call in process.on("SIGTERM") in API/Worker.
 */
export async function closeRedis() {
  await redis.quit();
}
