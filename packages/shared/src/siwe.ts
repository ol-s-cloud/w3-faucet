// packages/shared/src/siwe.ts
// Minimal, customizable SIWE (EIP-4361) helpers
// - Build message string
// - Extract nonce
// - Validate bound fields (domain/chain/nonce/address)

export type SiweBuildOpts = {
  domain: string;
  address: string;   // 0x...
  uri: string;       // your site origin
  chainId: number;   // e.g., 11155111 (Sepolia)
  statement: string; // human-readable intent text
  nonce: string;     // random hex/string
  issuedAt: string;  // ISO string
};

/** Build an EIP-4361 canonical message suitable for personal_sign */
export function buildSiweMessage(opts: SiweBuildOpts) {
  const { domain, address, uri, chainId, statement, nonce, issuedAt } = opts;
  return `${domain} wants you to sign in with your Ethereum account:
${address}

${statement}

URI: ${uri}
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${issuedAt}`;
}

/** Extracts the 'Nonce: ...' value from a SIWE message */
export function extractNonce(message: string) {
  const line = message.split("\n").find(l => l.startsWith("Nonce: "));
  return line ? line.slice(7).trim() : null;
}

/**
 * Validates that the message includes the values we expect to bind
 * (defense-in-depth against replay/cross-domain).
 */
export function validateSiweBindings(
  message: string,
  expect: {
    domain: string;
    chainId: number;
    address?: string; // optional: enforce address too
    nonce?: string;   // optional: if you already know the exact nonce
  }
) {
  const okDomain = message.startsWith(`${expect.domain} wants you to sign in`);
  const okChain = message.includes(`Chain ID: ${expect.chainId}`);
  const okAddr  = expect.address ? message.includes(`\n${expect.address}\n`) : true;
  const okNonce = expect.nonce   ? message.includes(`Nonce: ${expect.nonce}`) : true;
  return okDomain && okChain && okAddr && okNonce;
}
