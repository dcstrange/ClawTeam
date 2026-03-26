-- Up
-- Create explicit task participant graph for multi-bot collaboration

CREATE TABLE IF NOT EXISTS task_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  bot_id UUID NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'participant',
  added_by_bot_id UUID,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT task_participants_role_check CHECK (role IN ('delegator', 'executor', 'participant')),
  CONSTRAINT task_participants_unique_task_bot UNIQUE (task_id, bot_id)
);

CREATE INDEX IF NOT EXISTS idx_task_participants_task ON task_participants(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_participants_bot ON task_participants(bot_id, created_at DESC);

-- Backfill existing tasks
INSERT INTO task_participants (task_id, bot_id, role, added_by_bot_id)
SELECT t.id, t.from_bot_id, 'delegator', t.from_bot_id
  FROM tasks t
 WHERE t.from_bot_id IS NOT NULL
ON CONFLICT (task_id, bot_id) DO NOTHING;

INSERT INTO task_participants (task_id, bot_id, role, added_by_bot_id)
SELECT
  t.id,
  t.to_bot_id,
  CASE WHEN t.to_bot_id = t.from_bot_id THEN 'delegator' ELSE 'executor' END,
  t.from_bot_id
  FROM tasks t
 WHERE t.to_bot_id IS NOT NULL
ON CONFLICT (task_id, bot_id) DO NOTHING;

COMMENT ON TABLE task_participants IS 'Task collaboration participants (delegator/executor/collaborators)';
COMMENT ON COLUMN task_participants.task_id IS 'Task ID';
COMMENT ON COLUMN task_participants.bot_id IS 'Participant bot ID';
COMMENT ON COLUMN task_participants.role IS 'Participant role';
COMMENT ON COLUMN task_participants.added_by_bot_id IS 'Bot that added this participant';

-- Down
DROP INDEX IF EXISTS idx_task_participants_bot;
DROP INDEX IF EXISTS idx_task_participants_task;
DROP TABLE IF EXISTS task_participants;

