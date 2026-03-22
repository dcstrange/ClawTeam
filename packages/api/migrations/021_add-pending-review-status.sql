-- Up
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending','accepted','processing','waiting_for_input','pending_review','completed','failed','timeout','cancelled'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS submitted_result JSONB;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Down
UPDATE tasks SET status = 'processing' WHERE status = 'pending_review';
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending','accepted','processing','waiting_for_input','completed','failed','timeout','cancelled'));
ALTER TABLE tasks DROP COLUMN IF EXISTS submitted_result;
ALTER TABLE tasks DROP COLUMN IF EXISTS submitted_at;
ALTER TABLE tasks DROP COLUMN IF EXISTS rejection_reason;
