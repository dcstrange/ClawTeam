-- Up
-- File Service v0.1
-- 核心表：file_nodes / file_blobs / file_acl_entries / resource_events

CREATE TABLE IF NOT EXISTS file_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES file_nodes(id) ON DELETE CASCADE,
  scope VARCHAR(32) NOT NULL,
  scope_ref UUID,
  kind VARCHAR(16) NOT NULL,
  name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(255),
  size_bytes BIGINT,
  storage_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_by_actor_type VARCHAR(16) NOT NULL DEFAULT 'system',
  created_by_actor_id UUID,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMP,
  CONSTRAINT file_nodes_scope_check CHECK (scope IN ('bot_private', 'task', 'team_shared')),
  CONSTRAINT file_nodes_kind_check CHECK (kind IN ('folder', 'file', 'doc')),
  CONSTRAINT file_nodes_actor_type_check CHECK (created_by_actor_type IN ('bot', 'user', 'system')),
  CONSTRAINT file_nodes_scope_ref_check CHECK (
    (scope IN ('bot_private', 'task') AND scope_ref IS NOT NULL)
    OR (scope = 'team_shared')
  )
);

CREATE INDEX IF NOT EXISTS idx_file_nodes_team ON file_nodes(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_nodes_parent ON file_nodes(parent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_nodes_scope ON file_nodes(scope, scope_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_nodes_kind ON file_nodes(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_nodes_not_deleted ON file_nodes(team_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS file_blobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID NOT NULL REFERENCES file_nodes(id) ON DELETE CASCADE,
  storage_provider VARCHAR(32) NOT NULL DEFAULT 's3',
  storage_key TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  checksum_sha256 VARCHAR(64),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (node_id)
);

CREATE INDEX IF NOT EXISTS idx_file_blobs_storage_key ON file_blobs(storage_key);

CREATE TABLE IF NOT EXISTS doc_contents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id UUID NOT NULL REFERENCES file_nodes(id) ON DELETE CASCADE,
  revision INT NOT NULL,
  raw_text_snapshot TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(doc_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_doc_contents_doc_revision ON doc_contents(doc_id, revision DESC);

CREATE TABLE IF NOT EXISTS file_acl_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL REFERENCES file_nodes(id) ON DELETE CASCADE,
  subject_type VARCHAR(16) NOT NULL,
  subject_id TEXT NOT NULL,
  permission VARCHAR(16) NOT NULL,
  effect VARCHAR(16) NOT NULL DEFAULT 'allow',
  created_by_actor_type VARCHAR(16) NOT NULL DEFAULT 'system',
  created_by_actor_id UUID,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT file_acl_subject_type_check CHECK (subject_type IN ('user', 'bot', 'group', 'role')),
  CONSTRAINT file_acl_permission_check CHECK (permission IN ('view', 'edit', 'manage')),
  CONSTRAINT file_acl_effect_check CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT file_acl_actor_type_check CHECK (created_by_actor_type IN ('bot', 'user', 'system')),
  UNIQUE(resource_id, subject_type, subject_id, permission, effect)
);

CREATE INDEX IF NOT EXISTS idx_file_acl_resource ON file_acl_entries(resource_id);
CREATE INDEX IF NOT EXISTS idx_file_acl_subject ON file_acl_entries(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS resource_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID REFERENCES file_nodes(id) ON DELETE SET NULL,
  event_type VARCHAR(64) NOT NULL,
  actor_type VARCHAR(16) NOT NULL,
  actor_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT resource_events_actor_type_check CHECK (actor_type IN ('bot', 'user', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_resource_events_resource ON resource_events(resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resource_events_event_type ON resource_events(event_type, created_at DESC);

COMMENT ON TABLE file_nodes IS '文件服务节点（文件夹/文件/文档）';
COMMENT ON TABLE file_blobs IS '文件二进制对象映射（可接 S3/对象存储）';
COMMENT ON TABLE file_acl_entries IS '文件 ACL 条目（allow/deny）';
COMMENT ON TABLE resource_events IS '资源操作审计事件流';

-- Down
DROP INDEX IF EXISTS idx_resource_events_event_type;
DROP INDEX IF EXISTS idx_resource_events_resource;
DROP TABLE IF EXISTS resource_events;

DROP INDEX IF EXISTS idx_file_acl_subject;
DROP INDEX IF EXISTS idx_file_acl_resource;
DROP TABLE IF EXISTS file_acl_entries;

DROP INDEX IF EXISTS idx_file_blobs_storage_key;
DROP TABLE IF EXISTS file_blobs;

DROP INDEX IF EXISTS idx_doc_contents_doc_revision;
DROP TABLE IF EXISTS doc_contents;

DROP INDEX IF EXISTS idx_file_nodes_not_deleted;
DROP INDEX IF EXISTS idx_file_nodes_kind;
DROP INDEX IF EXISTS idx_file_nodes_scope;
DROP INDEX IF EXISTS idx_file_nodes_parent;
DROP INDEX IF EXISTS idx_file_nodes_team;
DROP TABLE IF EXISTS file_nodes;
