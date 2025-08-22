// === Domain enums ===
export type RequestStatus = "queued" | "sent" | "failed";

// === DB row types (match sql/001_init.sql) ===
export interface RequestRow {
  id: number;
  address: string;          // lowercased hex
  ip: string;               // plain IP (v4/v6)
  created_at: string;       // ISO timestamp
  status: RequestStatus;
  tx_hash: string | null;
  reason: string | null;
}

export interface NonceRow {
  id: number;
  address: string;          // lowercased hex
  nonce_hash: string;       // sha256(nonce)
  ip: string;
  created_at: string;       // ISO
  expires_at: string;       // ISO
  used: boolean;
}

export interface SessionRow {
  id: number;
  token_hash: string;       // sha256(sessionToken)
  address: string;          // lowercased hex
  ip: string;
  user_agent: string | null;
  created_at: string;       // ISO
  expires_at: string;       // ISO
}

export interface BudgetRow {
  d: string;                // YYYY-MM-DD
  drips: number;
}

// === Queue payloads ===
export type DripJob = {
  requestId: number;
  address: string;          // lowercased hex
  ip: string;
};

// === API-layer request/response contracts ===
// Keep these minimal and stable for the frontend and any SDK.

export interface DripRequest {
  address: string;          // must match session wallet
  signature: string;        // (not used on /drip in our flow, but OK to keep for future direct-verify)
  message: string;          // SIWE message (same note as above)
  captchaToken: string;     // Turnstile/reCAPTCHA token
}

export interface DripResponse {
  ok: boolean;              // canonical success flag
  error?: string;           // present when ok=false
  requestId?: number;       // present when ok=true
}

// SIWE nonce issuance
export interface AuthNonceRequest {
  address: string;
}

export interface AuthNonceResponse {
  ok: boolean;
  error?: string;
  nonce?: string;
  message?: string;         // SIWE message for personal_sign
  expiresAt?: string;       // ISO
}

// SIWE verify → session issuance
export interface AuthVerifyRequest {
  address: string;
  message: string;
  signature: string;
}

export interface AuthVerifyResponse {
  ok: boolean;
  error?: string;
  token?: string;           // bearer session token
  address?: string;         // normalized (lowercased) address
  expiresAt?: string;       // ISO
}

// Eligibility check (token gate)
export interface EligibilityResponse {
  ok: boolean;
  mode: "token-erc20" | "off" | "table" | "merkle";
  eligible: boolean;
  error?: string;
}

// Admin metrics (read-only)
export interface AdminMetrics {
  ok: boolean;
  error?: string;
  chainId?: number;
  faucet?: string | null;
  faucetBalanceEth?: string | null;
  tokenDecimals?: number;
  queue?: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    completed: number;
    [k: string]: number;
  };
  today?: { sent: number };
  lastHour?: { total: number; failed: number };
}
