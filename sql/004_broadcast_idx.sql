-- Partial index: WHERE status='broadcast' ORDER BY created_at
CREATE INDEX IF NOT EXISTS idx_requests_broadcast_created_at
  ON requests (created_at)
  WHERE status = 'broadcast';
