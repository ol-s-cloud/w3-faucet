-- Add 'broadcast' status so we don't miscount timeouts as failures
ALTER TABLE requests
  DROP CONSTRAINT IF EXISTS requests_status_check;

ALTER TABLE requests
  ADD CONSTRAINT requests_status_check
  CHECK (status IN ('queued','broadcast','sent','failed'));
