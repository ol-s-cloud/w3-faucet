-- Users table (wallets requesting drips)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    address TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Faucet request log
CREATE TABLE IF NOT EXISTS requests (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_hash TEXT NOT NULL,
    requested_at TIMESTAMP DEFAULT NOW(),
    status TEXT CHECK (status IN ('pending','sent','failed')) NOT NULL DEFAULT 'pending',
    tx_hash TEXT,
    amount NUMERIC(78, 0) NOT NULL, -- supports wei values
    UNIQUE (user_id, requested_at)
);

-- Simple rate-limit tracker
CREATE TABLE IF NOT EXISTS rate_limits (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    window_start TIMESTAMP NOT NULL,
    request_count INT NOT NULL DEFAULT 0
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user_id);
CREATE INDEX IF NOT EXISTS idx_requests_requested_at ON requests(requested_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_user ON rate_limits(user_id);
