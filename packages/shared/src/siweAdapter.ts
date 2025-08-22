// packages/shared/src/siweAdapter.ts
import { ethers } from "ethers";
import { buildSiweMessage as buildManual, extractNonce, validateSiweBindings } from "./siwe";
import { verify1271 } from "./verify1271";

export type SiweBuildOpts = {
  domain: string;
  address: string;
  uri: string;
  chainId: number;
  statement: string;
  nonce: string;
  issuedAt: string;
};

export type Strategy = "manual" | "library" | "prefer-manual" | "prefer-library" | "both";

export type VerifyExpect = {
  domain: string;
  chainId: number;
  address: string;       // expected signer (lowercased OK)
  exactNonce?: string;   // optional: assert this exact nonce is present
};

export type VerifyResult = {
  ok: boolean;
  method?: "eoa" | "erc1271" | "lib-eoa";
  recovered?: string;    // recovered EOA when applicable
  error?: string;
  discrepancy?: string;  // when strategies disagree in "prefer-*" modes
  trace: string[];       // debug breadcrumbs, never empty
};

const ENV_USE_SIWE_LIB = (process.env.USE_SIWE_LIB || "false").toLowerCase() === "true";

/** Build message via manual or library depending on env flag. */
export async function buildSiweMessage(opts: SiweBuildOpts): Promise<string> {
  if (!ENV_USE_SIWE_LIB) return buildManual(opts);
  try {
    const { SiweMessage } = await import("siwe");
    const msg = new SiweMessage({
      domain: opts.domain,
      address: ethers.getAddress(opts.address),
      statement: opts.statement,
      uri: opts.uri,
      version: "1",
      chainId: opts.chainId,
      nonce: opts.nonce,
      issuedAt: opts.issuedAt
    });
    return msg.prepareMessage();
  } catch (e: any) {
    // fallback to manual if library import fails
    return buildManual(opts);
  }
}

export function getNonceFromMessage(message: string): string | null {
  return extractNonce(message);
}

function checkBindings(message: string, expect: VerifyExpect): string | null {
  const okBasic = validateSiweBindings(message, {
    domain: expect.domain,
    chainId: expect.chainId,
    address: expect.address
  });
  if (!okBasic) return "binding check failed (domain/chain/address mismatch)";
  if (expect.exactNonce) {
    const okNonce = validateSiweBindings(message, {
      domain: expect.domain,
      chainId: expect.chainId,
      address: expect.address,
      nonce: expect.exactNonce
    });
    if (!okNonce) return "binding check failed (nonce mismatch)";
  }
  return null;
}

/** Internal helpers that never throw; they return {ok, ... , trace}. */
async function tryManual(
  provider: ethers.Provider,
  address: string,
  message: string,
  signature: string
): Promise<VerifyResult> {
  const trace: string[] = [];
  // EOA first
  try {
    const recovered = ethers.verifyMessage(message, signature);
    trace.push(`manual:eoa recovered=${recovered}`);
    if (recovered.toLowerCase() === address.toLowerCase()) {
      return { ok: true, method: "eoa", recovered, trace };
    }
    trace.push("manual:eoa mismatch");
  } catch (e: any) {
    trace.push(`manual:eoa error=${e?.message || String(e)}`);
  }

  // 1271 fallback
  try {
    const valid1271 = await verify1271(provider, address, message, signature);
    trace.push(`manual:1271 valid=${valid1271}`);
    if (valid1271) return { ok: true, method: "erc1271", trace };
  } catch (e: any) {
    trace.push(`manual:1271 error=${e?.message || String(e)}`);
  }

  return { ok: false, error: "manual verification failed", trace };
}

async function tryLib(
  address: string,
  message: string,
  signature: string
): Promise<VerifyResult> {
  const trace: string[] = [];
  try {
    const { SiweMessage } = await import("siwe");
    const verification = await new SiweMessage(message).verify({ signature });
    trace.push(`lib:verify success=${verification.success}`);
    if (!verification.success) {
      return { ok: false, error: "siwe library verify=false", trace };
    }
    const libAddr = verification.data?.address?.toLowerCase?.();
    trace.push(`lib:recovered=${libAddr}`);
    if (libAddr && libAddr !== address.toLowerCase()) {
      return { ok: false, error: "siwe library recovered address mismatch", trace };
    }
    return { ok: true, method: "lib-eoa", recovered: verification.data?.address, trace };
  } catch (e: any) {
    trace.push(`lib:error=${e?.message || String(e)}`);
    return { ok: false, error: `siwe library error: ${e?.message || String(e)}`, trace };
  }
}

/**
 * Unified verify with explicit strategy and rich debugging.
 * - Never throws; always returns { ok, method?, error?, trace[] }.
 * - Provider is required only for 1271 (manual path). Pass null if you know you don't need 1271.
 */
export async function verifySiwe(
  provider: ethers.Provider | null,
  address: string,
  message: string,
  signature: string,
  expect: VerifyExpect,
  strategy: Strategy = "prefer-manual"
): Promise<VerifyResult> {
  const pre = checkBindings(message, expect);
  if (pre) return { ok: false, error: pre, trace: ["bindings:fail"] };

  // Manual-only / Library-only
  if (strategy === "manual") {
    if (!provider) return { ok: false, error: "provider required for manual/1271 path", trace: ["manual:no-provider"] };
    return await tryManual(provider, address, message, signature);
  }
  if (strategy === "library") {
    return await tryLib(address, message, signature);
  }

  // Prefer-manual
  if (strategy === "prefer-manual") {
    if (!provider) return { ok: false, error: "provider required for manual/1271 path", trace: ["prefer-manual:no-provider"] };
    const m = await tryManual(provider, address, message, signature);
    if (m.ok) return m;
    // Try library as fallback only if env allows it
    if (!ENV_USE_SIWE_LIB) return { ...m, discrepancy: "library disabled via env", trace: [...m.trace, "lib:disabled"] };
    const l = await tryLib(address, message, signature);
    if (l.ok) return { ...l, discrepancy: "manual failed, library passed", trace: [...m.trace, ...l.trace] };
    return { ok: false, error: m.error || l.error || "verification failed", trace: [...m.trace, ...l.trace] };
  }

  // Prefer-library
  if (strategy === "prefer-library") {
    if (!ENV_USE_SIWE_LIB) return { ok: false, error: "library disabled via env", trace: ["lib:disabled"] };
    const l = await tryLib(address, message, signature);
    if (l.ok) return l;
    if (!provider) return { ...l, discrepancy: "manual fallback skipped (no provider)", trace: [...l.trace, "manual:no-provider"] };
    const m = await tryManual(provider, address, message, signature);
    if (m.ok) return { ...m, discrepancy: "library failed, manual passed", trace: [...l.trace, ...m.trace] };
    return { ok: false, error: l.error || m.error || "verification failed", trace: [...l.trace, ...m.trace] };
  }

  // Both: require agreement
  if (strategy === "both") {
    if (!ENV_USE_SIWE_LIB) return { ok: false, error: "library disabled via env", trace: ["both:lib-disabled"] };
    if (!provider) return { ok: false, error: "provider required for manual/1271 path", trace: ["both:no-provider"] };
    const [m, l] = await Promise.all([
      tryManual(provider, address, message, signature),
      tryLib(address, message, signature)
    ]);
    if (m.ok && l.ok) {
      // Prefer the stronger signal: EOA from both, else 1271+lib
      const agreedMethod = m.method === "eoa" && l.method === "lib-eoa" ? "eoa" : m.method || l.method;
      return { ok: true, method: agreedMethod, recovered: m.recovered || l.recovered, trace: [...m.trace, ...l.trace] };
    }
    const msg = `strategies disagree: manual=${m.ok ? "ok" : "fail"} lib=${l.ok ? "ok" : "fail"}`;
    return { ok: false, error: msg, discrepancy: msg, trace: [...m.trace, ...l.trace] };
  }

  return { ok: false, error: "unknown strategy", trace: ["strategy:unknown"] };
}
