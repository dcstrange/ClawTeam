/**
 * File Service Routes
 *
 * 首期能力：
 * - 创建文件夹
 * - 列表/详情查询
 * - 创建文档 + 读取文档纯文本
 * - 任务产物发布到 team_shared
 *
 * 共享模型：
 * - bot_private/<botId>
 * - task/<taskId>
 * - team_shared
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { ICapabilityRegistry } from '@clawteam/api/capability-registry';
import type { DatabasePool } from '@clawteam/api/common';
import { AuthenticationError, AuthorizationError, isClawTeamError, NotFoundError, ValidationError } from '@clawteam/api/common';
import { createAuthMiddleware } from '../task-coordinator/middleware/auth';
import { randomUUID } from 'crypto';
import { deleteBuffer, readBuffer, saveBuffer } from './storage';

type FileScope = 'bot_private' | 'task' | 'team_shared';
type FileKind = 'folder' | 'file' | 'doc';
type AccessPermission = 'view' | 'edit' | 'manage';
type AclEffect = 'allow' | 'deny';

interface FileRoutesDeps {
  db: DatabasePool;
  registry?: ICapabilityRegistry;
  userRepo?: import('@clawteam/api/capability-registry').IUserRepository;
}

interface FileNodeRow {
  id: string;
  team_id: string;
  parent_id: string | null;
  scope: FileScope;
  scope_ref: string | null;
  kind: FileKind;
  name: string;
  mime_type: string | null;
  size_bytes: string | null;
  storage_key: string | null;
  metadata: Record<string, unknown>;
  created_by_actor_type: 'bot' | 'user' | 'system';
  created_by_actor_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface AclRow {
  id: string;
  resource_id: string;
  subject_type: 'user' | 'bot' | 'group' | 'role';
  subject_id: string;
  permission: AccessPermission;
  effect: AclEffect;
}

interface TaskParticipantRow {
  id: string;
  from_bot_id: string;
  to_bot_id: string | null;
}

interface CreateFolderBody {
  name: string;
  parentId?: string;
  scope?: FileScope;
  scopeRef?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  clientToken?: string;
}

interface CreateDocBody {
  title: string;
  content?: string;
  parentId?: string;
  scope?: FileScope;
  scopeRef?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  clientToken?: string;
}

interface UploadFileBody {
  name: string;
  contentBase64: string;
  mimeType?: string;
  parentId?: string;
  scope?: FileScope;
  scopeRef?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  clientToken?: string;
}

interface UpdateDocRawBody {
  content: string;
  clientToken?: string;
}

interface MoveNodeBody {
  nodeId: string;
  targetParentId?: string;
  newName?: string;
  scope?: FileScope;
  scopeRef?: string;
  taskId?: string;
}

interface CopyNodeBody {
  sourceNodeId: string;
  targetParentId?: string;
  newName?: string;
  scope?: FileScope;
  scopeRef?: string;
  taskId?: string;
  clientToken?: string;
}

interface GrantAclBody {
  nodeId: string;
  subjectType: 'user' | 'bot' | 'group' | 'role';
  subjectId: string;
  permission: AccessPermission;
  effect?: AclEffect;
}

interface RevokeAclBody {
  nodeId: string;
  subjectType: 'user' | 'bot' | 'group' | 'role';
  subjectId: string;
  permission?: AccessPermission;
  effect?: AclEffect;
}

interface PublishBody {
  sourceNodeId: string;
  targetPath?: string;
  taskId?: string;
  clientToken?: string;
}

interface NodeParams {
  nodeId: string;
}

interface DocParams {
  docId: string;
}

interface DownloadParams {
  nodeId: string;
}

interface AclParams {
  nodeId: string;
}

interface DownloadQuery {
  format?: 'binary' | 'json';
}

interface ListFilesQuery {
  parentId?: string;
  scope?: FileScope;
  scopeRef?: string;
  page?: number;
  limit?: number;
}

interface ActorContext {
  actorType: 'bot' | 'user';
  actorId: string;
  teamId: string;
  botId?: string;
  userId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function getFallbackBotId(request: FastifyRequest): string {
  if (request.bot?.id) return request.bot.id;
  const headerBotId = request.headers['x-bot-id'];
  if (typeof headerBotId === 'string') return headerBotId;
  const queryBotId = (request.query as Record<string, unknown>).botId;
  if (typeof queryBotId === 'string') return queryBotId;
  return '';
}

function permissionLevel(permission: AccessPermission): number {
  if (permission === 'manage') return 3;
  if (permission === 'edit') return 2;
  return 1;
}

function canSatisfy(required: AccessPermission, granted: AccessPermission): boolean {
  return permissionLevel(granted) >= permissionLevel(required);
}

function mapNode(row: FileNodeRow): Record<string, unknown> {
  return {
    id: row.id,
    teamId: row.team_id,
    parentId: row.parent_id,
    scope: row.scope,
    scopeRef: row.scope_ref,
    kind: row.kind,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes ? Number(row.size_bytes) : null,
    storageKey: row.storage_key,
    metadata: row.metadata || {},
    createdByActorType: row.created_by_actor_type,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    deletedAt: row.deleted_at?.toISOString?.() ?? row.deleted_at,
  };
}

async function resolveActorContext(db: DatabasePool, request: FastifyRequest): Promise<ActorContext> {
  const authUser = (request as FastifyRequest & { authenticatedUser?: { id: string } }).authenticatedUser;
  if (authUser?.id) {
    const teamRes = await db.query<{ team_id: string }>(
      `SELECT team_id
       FROM team_members
       WHERE user_id = $1
       ORDER BY joined_at ASC
       LIMIT 1`,
      [authUser.id],
    );
    if ((teamRes.rowCount ?? 0) === 0) {
      throw new AuthorizationError('User is not a member of any team');
    }
    return {
      actorType: 'user',
      actorId: authUser.id,
      userId: authUser.id,
      teamId: teamRes.rows[0].team_id,
    };
  }

  if (request.bot?.id && request.bot.teamId) {
    return {
      actorType: 'bot',
      actorId: request.bot.id,
      botId: request.bot.id,
      teamId: request.bot.teamId,
    };
  }

  const fallbackBotId = getFallbackBotId(request);
  if (!fallbackBotId) {
    throw new AuthenticationError('Missing bot identity');
  }
  const botRes = await db.query<{ id: string; team_id: string }>(
    `SELECT id, team_id FROM bots WHERE id = $1 LIMIT 1`,
    [fallbackBotId],
  );
  if ((botRes.rowCount ?? 0) === 0) {
    throw new AuthenticationError('Bot identity is invalid');
  }
  return {
    actorType: 'bot',
    actorId: fallbackBotId,
    botId: fallbackBotId,
    teamId: botRes.rows[0].team_id,
  };
}

async function findNodeById(db: DatabasePool, nodeId: string): Promise<FileNodeRow | null> {
  const res = await db.query<FileNodeRow>(
    `SELECT id, team_id, parent_id, scope, scope_ref, kind, name, mime_type, size_bytes, storage_key,
            metadata, created_by_actor_type, created_by_actor_id, created_at, updated_at, deleted_at
       FROM file_nodes
      WHERE id = $1
      LIMIT 1`,
    [nodeId],
  );
  return (res.rowCount ?? 0) > 0 ? res.rows[0] : null;
}

async function getAclRows(db: DatabasePool, resourceId: string): Promise<AclRow[]> {
  const res = await db.query<AclRow>(
    `SELECT id, resource_id, subject_type, subject_id, permission, effect
       FROM file_acl_entries
      WHERE resource_id = $1`,
    [resourceId],
  );
  return res.rows;
}

async function isUserOwnerOfBot(db: DatabasePool, botId: string, userId: string): Promise<boolean> {
  const res = await db.query<{ id: string }>(
    `SELECT id
       FROM bots
      WHERE id = $1
        AND user_id = $2
      LIMIT 1`,
    [botId, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

async function isTaskParticipant(db: DatabasePool, taskId: string, actor: ActorContext): Promise<boolean> {
  if (actor.actorType === 'bot') {
    const res = await db.query<TaskParticipantRow>(
      `SELECT id, from_bot_id, to_bot_id
         FROM tasks
        WHERE id = $1
          AND (from_bot_id = $2 OR to_bot_id = $2)
        LIMIT 1`,
      [taskId, actor.botId!],
    );
    return (res.rowCount ?? 0) > 0;
  }

  const res = await db.query<TaskParticipantRow>(
    `SELECT t.id, t.from_bot_id, t.to_bot_id
       FROM tasks t
       LEFT JOIN bots bf ON bf.id = t.from_bot_id
       LEFT JOIN bots bt ON bt.id = t.to_bot_id
      WHERE t.id = $1
        AND (bf.user_id = $2 OR bt.user_id = $2)
      LIMIT 1`,
    [taskId, actor.userId!],
  );
  return (res.rowCount ?? 0) > 0;
}

async function canPublishForTask(db: DatabasePool, taskId: string, actor: ActorContext): Promise<boolean> {
  if (actor.actorType === 'bot') {
    const res = await db.query<{ id: string }>(
      `SELECT id
         FROM tasks
        WHERE id = $1
          AND from_bot_id = $2
        LIMIT 1`,
      [taskId, actor.botId!],
    );
    return (res.rowCount ?? 0) > 0;
  }

  const res = await db.query<{ id: string }>(
    `SELECT t.id
       FROM tasks t
       JOIN bots b ON b.id = t.from_bot_id
      WHERE t.id = $1
        AND b.user_id = $2
      LIMIT 1`,
    [taskId, actor.userId!],
  );
  return (res.rowCount ?? 0) > 0;
}

async function checkNamespaceDefaultAccess(
  db: DatabasePool,
  node: FileNodeRow,
  required: AccessPermission,
  actor: ActorContext,
): Promise<boolean> {
  if (node.scope === 'bot_private') {
    if (!node.scope_ref) return false;
    if (actor.actorType === 'bot') {
      return actor.botId === node.scope_ref;
    }
    if (actor.userId) {
      return isUserOwnerOfBot(db, node.scope_ref, actor.userId);
    }
    return false;
  }

  if (node.scope === 'task') {
    if (!node.scope_ref) return false;
    return isTaskParticipant(db, node.scope_ref, actor);
  }

  // team_shared
  if (node.team_id !== actor.teamId) return false;
  if (required === 'manage') {
    // manage 走显式 ACL，默认不开放
    return false;
  }
  return true;
}

async function hasAccess(
  db: DatabasePool,
  node: FileNodeRow,
  required: AccessPermission,
  actor: ActorContext,
): Promise<boolean> {
  if (node.deleted_at) return false;
  if (node.team_id !== actor.teamId) return false;

  const subjects: Array<{ type: 'user' | 'bot'; id: string }> = [];
  if (actor.botId) subjects.push({ type: 'bot', id: actor.botId });
  if (actor.userId) subjects.push({ type: 'user', id: actor.userId });

  let current: FileNodeRow | null = node;
  while (current) {
    const aclRows = await getAclRows(db, current.id);
    const relevant = aclRows.filter((r) => subjects.some((s) => s.type === r.subject_type && s.id === r.subject_id));

    const hasDeny = relevant.some((r) => r.effect === 'deny' && canSatisfy(required, r.permission));
    if (hasDeny) return false;

    const hasAllow = relevant.some((r) => r.effect === 'allow' && canSatisfy(required, r.permission));
    if (hasAllow) return true;

    if (!current.parent_id) break;
    current = await findNodeById(db, current.parent_id);
  }

  return checkNamespaceDefaultAccess(db, node, required, actor);
}

function normalizeScopeInput(
  bodyScope: FileScope | undefined,
  bodyScopeRef: string | undefined,
  taskId: string | undefined,
  actor: ActorContext,
): { scope: FileScope; scopeRef: string | null } {
  if (bodyScope) {
    if (bodyScope === 'team_shared') {
      return { scope: 'team_shared', scopeRef: null };
    }
    if ((bodyScope === 'bot_private' || bodyScope === 'task') && !bodyScopeRef) {
      throw new ValidationError(`scopeRef is required when scope=${bodyScope}`);
    }
    if ((bodyScope === 'bot_private' || bodyScope === 'task') && bodyScopeRef && !isUuid(bodyScopeRef)) {
      throw new ValidationError(`scopeRef must be UUID when scope=${bodyScope}`);
    }
    return { scope: bodyScope, scopeRef: bodyScopeRef || null };
  }

  if (taskId) {
    if (!isUuid(taskId)) {
      throw new ValidationError('taskId must be a valid UUID');
    }
    return { scope: 'task', scopeRef: taskId };
  }

  if (actor.actorType === 'bot' && actor.botId) {
    return { scope: 'bot_private', scopeRef: actor.botId };
  }

  throw new ValidationError('scope is required for user calls when taskId is not provided');
}

function ensureValidName(name: string, field: string): void {
  if (!name || !name.trim()) {
    throw new ValidationError(`${field} is required`);
  }
  if (name.trim().length > 255) {
    throw new ValidationError(`${field} exceeds max length 255`);
  }
}

function decodeBase64Payload(contentBase64: string): Buffer {
  const normalized = contentBase64.trim();
  if (!normalized) {
    return Buffer.alloc(0);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new ValidationError('contentBase64 is not valid base64');
  }
  return Buffer.from(normalized, 'base64');
}

function normalizeOptionalName(name: string | undefined, fallback: string): string {
  if (name === undefined) return fallback;
  const trimmed = name.trim();
  if (!trimmed) {
    throw new ValidationError('newName cannot be empty');
  }
  ensureValidName(trimmed, 'newName');
  return trimmed;
}

async function assertWritableScope(
  db: DatabasePool,
  actor: ActorContext,
  scope: FileScope,
  scopeRef: string | null,
): Promise<void> {
  if (scope === 'task') {
    if (!scopeRef) throw new ValidationError('scopeRef is required for task scope');
    if (!isUuid(scopeRef)) throw new ValidationError('scopeRef must be a valid UUID');
    const participant = await isTaskParticipant(db, scopeRef, actor);
    if (!participant) throw new AuthorizationError('Actor is not task participant');
    return;
  }

  if (scope === 'team_shared') {
    if (actor.actorType === 'bot') {
      throw new AuthorizationError('Bot cannot write team_shared directly, use publish flow');
    }
    return;
  }

  // bot_private
  if (!scopeRef) throw new ValidationError('scopeRef is required for bot_private');
  if (actor.actorType === 'bot' && actor.botId !== scopeRef) {
    throw new AuthorizationError('Bot cannot write into another bot private scope');
  }
  if (actor.actorType === 'user' && actor.userId) {
    const owns = await isUserOwnerOfBot(db, scopeRef, actor.userId);
    if (!owns) throw new AuthorizationError('User does not own target bot private scope');
  }
}

async function resolvePlacement(
  db: DatabasePool,
  actor: ActorContext,
  input: {
    targetParentId?: string;
    scope?: FileScope;
    scopeRef?: string;
    taskId?: string;
  },
): Promise<{ teamId: string; parentId: string | null; scope: FileScope; scopeRef: string | null }> {
  if (input.targetParentId) {
    const parent = await findNodeById(db, input.targetParentId);
    if (!parent || parent.deleted_at) {
      throw new NotFoundError('file_node', input.targetParentId);
    }
    if (parent.kind !== 'folder') {
      throw new ValidationError('targetParentId must reference a folder');
    }
    const canEditParent = await hasAccess(db, parent, 'edit', actor);
    if (!canEditParent) {
      throw new AuthorizationError('No permission to write into target parent');
    }
    return {
      teamId: parent.team_id,
      parentId: parent.id,
      scope: parent.scope,
      scopeRef: parent.scope_ref,
    };
  }

  const normalized = normalizeScopeInput(input.scope, input.scopeRef, input.taskId, actor);
  await assertWritableScope(db, actor, normalized.scope, normalized.scopeRef);
  return {
    teamId: actor.teamId,
    parentId: null,
    scope: normalized.scope,
    scopeRef: normalized.scopeRef,
  };
}

async function assertNotMoveIntoDescendant(
  db: DatabasePool,
  sourceNodeId: string,
  targetParentId: string | null,
): Promise<void> {
  if (!targetParentId) return;
  let cursor: FileNodeRow | null = await findNodeById(db, targetParentId);
  while (cursor) {
    if (cursor.id === sourceNodeId) {
      throw new ValidationError('Cannot move a node into itself or its descendant');
    }
    if (!cursor.parent_id) break;
    cursor = await findNodeById(db, cursor.parent_id);
  }
}

async function listChildren(db: DatabasePool, parentId: string): Promise<FileNodeRow[]> {
  const res = await db.query<FileNodeRow>(
    `SELECT id, team_id, parent_id, scope, scope_ref, kind, name, mime_type, size_bytes, storage_key,
            metadata, created_by_actor_type, created_by_actor_id, created_at, updated_at, deleted_at
       FROM file_nodes
      WHERE parent_id = $1
        AND deleted_at IS NULL
      ORDER BY created_at ASC`,
    [parentId],
  );
  return res.rows;
}

async function cloneNodeTree(
  db: DatabasePool,
  source: FileNodeRow,
  actor: ActorContext,
  placement: { teamId: string; parentId: string | null; scope: FileScope; scopeRef: string | null; name?: string },
): Promise<FileNodeRow> {
  const clonedMetadata = {
    ...(source.metadata || {}),
    copiedFromNodeId: source.id,
  };
  const clonedName = placement.name || source.name;

  const insertNodeRes = await db.query<FileNodeRow>(
    `INSERT INTO file_nodes (
        team_id, parent_id, scope, scope_ref, kind, name, mime_type, size_bytes, storage_key, metadata,
        created_by_actor_type, created_by_actor_id
     )
     VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::uuid)
     RETURNING id, team_id, parent_id, scope, scope_ref, kind, name, mime_type, size_bytes, storage_key,
               metadata, created_by_actor_type, created_by_actor_id, created_at, updated_at, deleted_at`,
    [
      placement.teamId,
      placement.parentId,
      placement.scope,
      placement.scopeRef,
      source.kind,
      clonedName,
      source.mime_type,
      source.size_bytes,
      source.storage_key,
      JSON.stringify(clonedMetadata),
      actor.actorType,
      actor.actorId,
    ],
  );
  const clonedNode = insertNodeRes.rows[0];

  if (source.kind === 'doc') {
    const latestDocRes = await db.query<{ raw_text_snapshot: string }>(
      `SELECT raw_text_snapshot
         FROM doc_contents
        WHERE doc_id = $1
        ORDER BY revision DESC
        LIMIT 1`,
      [source.id],
    );
    await db.query(
      `INSERT INTO doc_contents (doc_id, revision, raw_text_snapshot, updated_at)
       VALUES ($1, 1, $2, NOW())`,
      [clonedNode.id, (latestDocRes.rowCount ?? 0) > 0 ? latestDocRes.rows[0].raw_text_snapshot || '' : ''],
    );
  }

  if (source.kind === 'file') {
    const blobRes = await db.query<{
      storage_provider: string;
      storage_key: string;
      size_bytes: string;
      checksum_sha256: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT storage_provider, storage_key, size_bytes, checksum_sha256, metadata
         FROM file_blobs
        WHERE node_id = $1
        LIMIT 1`,
      [source.id],
    );
    if ((blobRes.rowCount ?? 0) > 0) {
      const blob = blobRes.rows[0];
      await db.query(
        `INSERT INTO file_blobs (node_id, storage_provider, storage_key, size_bytes, checksum_sha256, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          clonedNode.id,
          blob.storage_provider,
          blob.storage_key,
          blob.size_bytes,
          blob.checksum_sha256,
          JSON.stringify({
            ...(blob.metadata || {}),
            copiedFromNodeId: source.id,
          }),
        ],
      );
    }
  }

  if (source.kind === 'folder') {
    const children = await listChildren(db, source.id);
    for (const child of children) {
      await cloneNodeTree(db, child, actor, {
        teamId: clonedNode.team_id,
        parentId: clonedNode.id,
        scope: clonedNode.scope,
        scopeRef: clonedNode.scope_ref,
      });
    }
  }

  return clonedNode;
}

function handleError(error: unknown, reply: FastifyReply, traceId: string): FastifyReply {
  if (isClawTeamError(error)) {
    return reply.status(error.statusCode).send({
      success: false,
      error: error.toJSON(),
      traceId,
    });
  }

  const err = error as Error;
  return reply.status(500).send({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: err.message || 'Internal server error',
    },
    traceId,
  });
}

export function createFileRoutes(deps: FileRoutesDeps): FastifyPluginAsync {
  const { db, registry, userRepo } = deps;

  return async (fastify) => {
    if (!fastify.hasRequestDecorator('bot')) {
      fastify.decorateRequest('bot', undefined as any);
    }

    const authPreHandlers: preHandlerHookHandler[] = [];
    if (registry) {
      authPreHandlers.push(createAuthMiddleware(registry, userRepo));
    }

    fastify.setErrorHandler((error, _request, reply) => {
      if (isClawTeamError(error)) {
        return reply.status(error.statusCode).send({
          success: false,
          error: error.toJSON(),
        });
      }
      const err = error as Error;
      return reply.status(500).send({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal server error' },
      });
    });

    // ---------------------------------------------------------------------
    // POST /folders
    // ---------------------------------------------------------------------
    fastify.post<{ Body: CreateFolderBody }>(
      '/folders',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const body = request.body || ({} as CreateFolderBody);
          ensureValidName(body.name, 'name');

          let teamId = actor.teamId;
          let parentId: string | null = null;
          let scope: FileScope;
          let scopeRef: string | null;

          if (body.parentId) {
            const parent = await findNodeById(db, body.parentId);
            if (!parent || parent.deleted_at) throw new NotFoundError('file_node', body.parentId);
            if (parent.kind !== 'folder') {
              throw new ValidationError('parentId must reference a folder');
            }
            const canEditParent = await hasAccess(db, parent, 'edit', actor);
            if (!canEditParent) throw new AuthorizationError('No permission to create under this parent');

            parentId = parent.id;
            teamId = parent.team_id;
            scope = parent.scope;
            scopeRef = parent.scope_ref;
          } else {
            const normalized = normalizeScopeInput(body.scope, body.scopeRef, body.taskId, actor);
            scope = normalized.scope;
            scopeRef = normalized.scopeRef;

            if (scope === 'bot_private') {
              if (!scopeRef) throw new ValidationError('scopeRef is required for bot_private');
              if (actor.actorType === 'bot' && actor.botId !== scopeRef) {
                throw new AuthorizationError('Bot cannot create in another bot private scope');
              }
              if (actor.actorType === 'user' && actor.userId) {
                const owns = await isUserOwnerOfBot(db, scopeRef, actor.userId);
                if (!owns) throw new AuthorizationError('User does not own target bot private scope');
              }
            }

            if (scope === 'task') {
              if (!scopeRef) throw new ValidationError('scopeRef is required for task scope');
              if (!isUuid(scopeRef)) throw new ValidationError('scopeRef must be a valid UUID');
              const participant = await isTaskParticipant(db, scopeRef, actor);
              if (!participant) throw new AuthorizationError('Actor is not task participant');
            }

            if (scope === 'team_shared' && actor.actorType === 'bot') {
              throw new AuthorizationError('Bot cannot write team_shared directly, use publish flow');
            }
          }

          const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
          const insertRes = await db.query<FileNodeRow>(
            `INSERT INTO file_nodes (
                team_id, parent_id, scope, scope_ref, kind, name, metadata,
                created_by_actor_type, created_by_actor_id
             )
             VALUES ($1, $2, $3, $4::uuid, 'folder', $5, $6::jsonb, $7, $8::uuid)
             RETURNING id, team_id, parent_id, scope, scope_ref, kind, name, mime_type, size_bytes, storage_key,
                       metadata, created_by_actor_type, created_by_actor_id, created_at, updated_at, deleted_at`,
            [
              teamId,
              parentId,
              scope,
              scopeRef,
              body.name.trim(),
              JSON.stringify(metadata),
              actor.actorType,
              actor.actorId,
            ],
          );
          const created = insertRes.rows[0];

          await db.query(
            `INSERT INTO resource_events (resource_id, event_type, actor_type, actor_id, payload)
             VALUES ($1, 'folder_created', $2, $3, $4::jsonb)`,
            [created.id, actor.actorType, actor.actorId, JSON.stringify({ parentId, scope, scopeRef })],
          );

          return reply.status(201).send({
            success: true,
            data: { node: mapNode(created) },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ---------------------------------------------------------------------
    // POST /docs
    // ---------------------------------------------------------------------
    fastify.post<{ Body: CreateDocBody }>(
      '/docs',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const body = request.body || ({} as CreateDocBody);
          ensureValidName(body.title, 'title');

          let teamId = actor.teamId;
          let parentId: string | null = null;
          let scope: FileScope;
          let scopeRef: string | null;

          if (body.parentId) {
            const parent = await findNodeById(db, body.parentId);
            if (!parent || parent.deleted_at) throw new NotFoundError('file_node', body.parentId);
            if (parent.kind !== 'folder') throw new ValidationError('parentId must reference a folder');
            const canEditParent = await hasAccess(db, parent, 'edit', actor);
            if (!canEditParent) throw new AuthorizationError('No permission to create under this parent');
            teamId = parent.team_id;
            parentId = parent.id;
            scope = parent.scope;
            scopeRef = parent.scope_ref;
          } else {
            const normalized = normalizeScopeInput(body.scope, body.scopeRef, body.taskId, actor);
            scope = normalized.scope;
            scopeRef = normalized.scopeRef;
          }

          if (scope === 'task') {
            if (!scopeRef) throw new ValidationError('scopeRef is required for task scope');
            if (!isUuid(scopeRef)) throw new ValidationError('scopeRef must be a valid UUID');
            const participant = await isTaskParticipant(db, scopeRef, actor);
            if (!participant) throw new AuthorizationError('Actor is not task participant');
          }
          if (scope === 'team_shared' && actor.actorType === 'bot') {
            throw new AuthorizationError('Bot cannot write team_shared directly, use publish flow');
          }
          if (scope === 'bot_private') {
            if (!scopeRef) throw new ValidationError('scopeRef is required for bot_private');
            if (actor.actorType === 'bot' && actor.botId !== scopeRef) {
              throw new AuthorizationError('Bot cannot create in another bot private scope');
            }
            if (actor.actorType === 'user' && actor.userId) {
              const owns = await isUserOwnerOfBot(db, scopeRef, actor.userId);
              if (!owns) throw new AuthorizationError('User does not own target bot private scope');
            }
          }

          const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
          const content = typeof body.content === 'string' ? body.content : '';

          const nodeRes = await db.query<FileNodeRow>(
            `INSERT INTO file_nodes (
                team_id, parent_id, scope, scope_ref, kind, name, mime_type, size_bytes, metadata,
                created_by_actor_type, created_by_actor_id
             )
             VALUES ($1, $2, $3, $4::uuid, 'doc', $5, 'text/plain', $6, $7::jsonb, $8, $9::uuid)
             RETURNING id, team_id, parent_id, scope, scope_ref, kind, name, mime_type, size_bytes, storage_key,
                       metadata, created_by_actor_type, created_by_actor_id, created_at, updated_at, deleted_at`,
            [
              teamId,
              parentId,
              scope,
              scopeRef,
              body.title.trim(),
              Buffer.byteLength(content, 'utf8'),
              JSON.stringify(metadata),
              actor.actorType,
              actor.actorId,
            ],
          );
          const docNode = nodeRes.rows[0];

          await db.query(
            `INSERT INTO doc_contents (doc_id, revision, raw_text_snapshot, updated_at)
             VALUES ($1, 1, $2, NOW())`,
            [docNode.id, content],
          ).catch(async (err) => {
            // 兼容首次迁移未落地时的明确错误提示
            throw new ValidationError('doc_contents table is missing. Please run latest migrations.', {
              original: (err as Error).message,
            });
          });

          await db.query(
            `INSERT INTO resource_events (resource_id, event_type, actor_type, actor_id, payload)
             VALUES ($1, 'doc_created', $2, $3, $4::jsonb)`,
            [docNode.id, actor.actorType, actor.actorId, JSON.stringify({ parentId, scope, scopeRef })],
          );

          return reply.status(201).send({
            success: true,
            data: { node: mapNode(docNode), revision: 1 },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ---------------------------------------------------------------------
    // POST /upload
    // ---------------------------------------------------------------------
    fastify.post<{ Body: UploadFileBody }>(
      '/upload',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const body = request.body || ({} as UploadFileBody);

          ensureValidName(body.name, 'name');
          if (typeof body.contentBase64 !== 'string') {
            throw new ValidationError('contentBase64 is required');
          }

          const fileBuffer = decodeBase64Payload(body.contentBase64);

          let teamId = actor.teamId;
          let parentId: string | null = null;
          let scope: FileScope;
          let scopeRef: string | null;

          if (body.parentId) {
            const parent = await findNodeById(db, body.parentId);
            if (!parent || parent.deleted_at) throw new NotFoundError('file_node', body.parentId);
            if (parent.kind !== 'folder') throw new ValidationError('parentId must reference a folder');
            const canEditParent = await hasAccess(db, parent, 'edit', actor);
            if (!canEditParent) throw new AuthorizationError('No permission to create under this parent');

            teamId = parent.team_id;
            parentId = parent.id;
            scope = parent.scope;
            scopeRef = parent.scope_ref;
          } else {
            const normalized = normalizeScopeInput(body.scope, body.scopeRef, body.taskId, actor);
            scope = normalized.scope;
            scopeRef = normalized.scopeRef;
          }

          if (scope === 'task') {
            if (!scopeRef) throw new ValidationError('scopeRef is required for task scope');
            if (!isUuid(scopeRef)) throw new ValidationError('scopeRef must be a valid UUID');
            const participant = await isTaskParticipant(db, scopeRef, actor);
            if (!participant) throw new AuthorizationError('Actor is not task participant');
          }
          if (scope === 'team_shared' && actor.actorType === 'bot') {
            throw new AuthorizationError('Bot cannot write team_shared directly, use publish flow');
          }
          if (scope === 'bot_private') {
            if (!scopeRef) throw new ValidationError('scopeRef is required for bot_private');
            if (actor.actorType === 'bot' && actor.botId !== scopeRef) {
              throw new AuthorizationError('Bot cannot create in another bot private scope');
            }
            if (actor.actorType === 'user' && actor.userId) {
              const owns = await isUserOwnerOfBot(db, scopeRef, actor.userId);
              if (!owns) throw new AuthorizationError('User does not own target bot private scope');
            }
          }

          const blob = await saveBuffer(fileBuffer);

          const mimeType = typeof body.mimeType === 'string' && body.mimeType.trim()
            ? body.mimeType.trim()
            : 'application/octet-stream';

          const metadata = {
            ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
            uploadEncoding: 'base64',
          };

          try {
            const nodeRes = await db.query<FileNodeRow>(
              `INSERT INTO file_nodes (
                  team_id, parent_id, scope, scope_ref, kind, name, mime_type, size_bytes, storage_key, metadata,
                  created_by_actor_type, created_by_actor_id
               )
               VALUES ($1, $2, $3, $4::uuid, 'file', $5, $6, $7, $8, $9::jsonb, $10, $11::uuid)
               RETURNING id, team_id, parent_id, scope, scope_ref, kind, name, mime_type, size_bytes, storage_key,
                         metadata, created_by_actor_type, created_by_actor_id, created_at, updated_at, deleted_at`,
              [
                teamId,
                parentId,
                scope,
                scopeRef,
                body.name.trim(),
                mimeType,
                blob.sizeBytes,
                blob.storageKey,
                JSON.stringify(metadata),
                actor.actorType,
                actor.actorId,
              ],
            );
            const created = nodeRes.rows[0];

            await db.query(
              `INSERT INTO file_blobs (node_id, storage_provider, storage_key, size_bytes, checksum_sha256, metadata)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
              [
                created.id,
                blob.storageProvider,
                blob.storageKey,
                blob.sizeBytes,
                blob.checksumSha256,
                JSON.stringify({
                  originalFileName: body.name.trim(),
                  clientToken: body.clientToken || null,
                }),
              ],
            );

            await db.query(
              `INSERT INTO resource_events (resource_id, event_type, actor_type, actor_id, payload)
               VALUES ($1, 'file_uploaded', $2, $3, $4::jsonb)`,
              [created.id, actor.actorType, actor.actorId, JSON.stringify({ parentId, scope, scopeRef, sizeBytes: blob.sizeBytes })],
            );

            return reply.status(201).send({
              success: true,
              data: {
                node: mapNode(created),
                checksumSha256: blob.checksumSha256,
              },
              traceId,
            });
          } catch (error) {
            await deleteBuffer(blob.storageKey).catch(() => undefined);
            throw error;
          }
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ---------------------------------------------------------------------
    // GET /docs/:docId/raw
    // ---------------------------------------------------------------------
    fastify.get<{ Params: DocParams }>(
      '/docs/:docId/raw',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const node = await findNodeById(db, request.params.docId);
          if (!node || node.deleted_at) throw new NotFoundError('file_node', request.params.docId);
          if (node.kind !== 'doc') throw new ValidationError('docId does not reference a doc node');

          const canRead = await hasAccess(db, node, 'view', actor);
          if (!canRead) throw new AuthorizationError('No permission to read this document');

          const contentRes = await db.query<{ revision: number; raw_text_snapshot: string; updated_at: Date }>(
            `SELECT revision, raw_text_snapshot, updated_at
               FROM doc_contents
              WHERE doc_id = $1
              ORDER BY revision DESC
              LIMIT 1`,
            [node.id],
          );

          if ((contentRes.rowCount ?? 0) === 0) {
            return reply.send({
              success: true,
              data: {
                docId: node.id,
                revision: 0,
                content: '',
                updatedAt: null,
              },
              traceId,
            });
          }

          const latest = contentRes.rows[0];
          return reply.send({
            success: true,
            data: {
              docId: node.id,
              revision: latest.revision,
              content: latest.raw_text_snapshot || '',
              updatedAt: latest.updated_at?.toISOString?.() ?? latest.updated_at,
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ---------------------------------------------------------------------
    // PUT /docs/:docId/raw
    // ---------------------------------------------------------------------
    fastify.put<{ Params: DocParams; Body: UpdateDocRawBody }>(
      '/docs/:docId/raw',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const body = request.body || ({} as UpdateDocRawBody);
          if (typeof body.content !== 'string') {
            throw new ValidationError('content is required');
          }

          const node = await findNodeById(db, request.params.docId);
          if (!node || node.deleted_at) throw new NotFoundError('file_node', request.params.docId);
          if (node.kind !== 'doc') throw new ValidationError('docId does not reference a doc node');

          const canEdit = await hasAccess(db, node, 'edit', actor);
          if (!canEdit) throw new AuthorizationError('No permission to edit this document');

          const latestRes = await db.query<{ revision: number }>(
            `SELECT revision
               FROM doc_contents
              WHERE doc_id = $1
              ORDER BY revision DESC
              LIMIT 1`,
            [node.id],
          );
          const nextRevision = (latestRes.rowCount ?? 0) > 0
            ? latestRes.rows[0].revision + 1
            : 1;

          await db.query(
            `INSERT INTO doc_contents (doc_id, revision, raw_text_snapshot, updated_at)
             VALUES ($1, $2, $3, NOW())`,
            [node.id, nextRevision, body.content],
          );

          const sizeBytes = Buffer.byteLength(body.content, 'utf8');
          await db.query(
            `UPDATE file_nodes
                SET size_bytes = $1,
                    updated_at = NOW()
              WHERE id = $2`,
            [sizeBytes, node.id],
          );

          await db.query(
            `INSERT INTO resource_events (resource_id, event_type, actor_type, actor_id, payload)
             VALUES ($1, 'doc_updated', $2, $3, $4::jsonb)`,
            [node.id, actor.actorType, actor.actorId, JSON.stringify({ revision: nextRevision })],
          );

          return reply.send({
            success: true,
            data: {
              docId: node.id,
              revision: nextRevision,
              sizeBytes,
              updatedAt: new Date().toISOString(),
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ---------------------------------------------------------------------
    // GET /
    // ---------------------------------------------------------------------
    fastify.get<{ Querystring: ListFilesQuery }>(
      '/',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const { parentId, scope: queryScope, scopeRef: queryScopeRef } = request.query || {};
          const page = Math.max(1, Number(request.query.page || 1));
          const limit = Math.min(200, Math.max(1, Number(request.query.limit || 50)));
          const offset = (page - 1) * limit;

          if (parentId) {
            const parent = await findNodeById(db, parentId);
            if (!parent || parent.deleted_at) throw new NotFoundError('file_node', parentId);
            const canReadParent = await hasAccess(db, parent, 'view', actor);
            if (!canReadParent) throw new AuthorizationError('No permission to access this parent');

            const childrenRes = await db.query<FileNodeRow>(
              `SELECT id, team_id, parent_id, scope, scope_ref, kind, name, mime_type, size_bytes, storage_key,
                      metadata, created_by_actor_type, created_by_actor_id, created_at, updated_at, deleted_at
                 FROM file_nodes
                WHERE parent_id = $1
                  AND deleted_at IS NULL
                ORDER BY kind ASC, created_at DESC
                LIMIT $2 OFFSET $3`,
              [parent.id, limit, offset],
            );

            const visible: Record<string, unknown>[] = [];
            for (const row of childrenRes.rows) {
              if (await hasAccess(db, row, 'view', actor)) {
                visible.push(mapNode(row));
              }
            }

            return reply.send({
              success: true,
              data: {
                parentId: parent.id,
                items: visible,
                page,
                limit,
              },
              traceId,
            });
          }

          let scope: FileScope;
          let scopeRef: string | null = null;
          if (queryScope) {
            scope = queryScope;
            scopeRef = queryScopeRef || null;
          } else if (actor.actorType === 'bot' && actor.botId) {
            scope = 'bot_private';
            scopeRef = actor.botId;
          } else {
            scope = 'team_shared';
            scopeRef = null;
          }

          if (scope === 'team_shared') {
            scopeRef = null;
          }

          if ((scope === 'bot_private' || scope === 'task') && !scopeRef) {
            throw new ValidationError(`scopeRef is required when scope=${scope}`);
          }
          if ((scope === 'bot_private' || scope === 'task') && scopeRef && !isUuid(scopeRef)) {
            throw new ValidationError('scopeRef must be a valid UUID');
          }

          if (scope === 'bot_private' && scopeRef) {
            if (actor.actorType === 'bot' && actor.botId !== scopeRef) {
              throw new AuthorizationError('Bot cannot list another bot private scope');
            }
            if (actor.actorType === 'user' && actor.userId) {
              const owns = await isUserOwnerOfBot(db, scopeRef, actor.userId);
              if (!owns) throw new AuthorizationError('User does not own target bot private scope');
            }
          }
          if (scope === 'task' && scopeRef) {
            const participant = await isTaskParticipant(db, scopeRef, actor);
            if (!participant) throw new AuthorizationError('Actor is not task participant');
          }

          const rowsRes = await db.query<FileNodeRow>(
            `SELECT id, team_id, parent_id, scope, scope_ref, kind, name, mime_type, size_bytes, storage_key,
                    metadata, created_by_actor_type, created_by_actor_id, created_at, updated_at, deleted_at
               FROM file_nodes
              WHERE team_id = $1
                AND scope = $2
                AND (($3::uuid IS NULL AND scope_ref IS NULL) OR scope_ref = $3::uuid)
                AND parent_id IS NULL
                AND deleted_at IS NULL
              ORDER BY kind ASC, created_at DESC
              LIMIT $4 OFFSET $5`,
            [actor.teamId, scope, scopeRef, limit, offset],
          );

          const visible: Record<string, unknown>[] = [];
          for (const row of rowsRes.rows) {
            if (await hasAccess(db, row, 'view', actor)) {
              visible.push(mapNode(row));
            }
          }

          return reply.send({
            success: true,
            data: {
              scope,
              scopeRef,
              items: visible,
              page,
              limit,
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ---------------------------------------------------------------------
    // GET /download/:nodeId
    // ---------------------------------------------------------------------
    fastify.get<{ Params: DownloadParams; Querystring: DownloadQuery }>(
      '/download/:nodeId',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const node = await findNodeById(db, request.params.nodeId);
          if (!node || node.deleted_at) throw new NotFoundError('file_node', request.params.nodeId);
          if (node.kind !== 'file') throw new ValidationError('nodeId does not reference a file node');

          const canRead = await hasAccess(db, node, 'view', actor);
          if (!canRead) throw new AuthorizationError('No permission to download this file');

          const blobRes = await db.query<{
            storage_provider: string;
            storage_key: string;
            size_bytes: string;
            checksum_sha256: string | null;
            metadata: Record<string, unknown>;
          }>(
            `SELECT storage_provider, storage_key, size_bytes, checksum_sha256, metadata
               FROM file_blobs
              WHERE node_id = $1
              LIMIT 1`,
            [node.id],
          );
          if ((blobRes.rowCount ?? 0) === 0) {
            throw new NotFoundError('file_blob', node.id);
          }

          const blob = blobRes.rows[0];
          let buffer: Buffer;
          try {
            buffer = await readBuffer(blob.storage_key);
          } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code === 'ENOENT') {
              throw new NotFoundError('file_blob_content', node.id);
            }
            throw err;
          }

          if (request.query?.format === 'json') {
            return reply.send({
              success: true,
              data: {
                nodeId: node.id,
                name: node.name,
                mimeType: node.mime_type || 'application/octet-stream',
                sizeBytes: buffer.byteLength,
                checksumSha256: blob.checksum_sha256,
                contentBase64: buffer.toString('base64'),
              },
              traceId,
            });
          }

          reply
            .header('content-type', node.mime_type || 'application/octet-stream')
            .header('content-length', String(buffer.byteLength))
            .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(node.name)}`)
            .header('x-trace-id', traceId);
          return reply.send(buffer);
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ---------------------------------------------------------------------
    // POST /move
    // ---------------------------------------------------------------------
    fastify.post<{ Body: MoveNodeBody }>(
      '/move',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const body = request.body || ({} as MoveNodeBody);
          if (!body.nodeId) throw new ValidationError('nodeId is required');

          const source = await findNodeById(db, body.nodeId);
          if (!source || source.deleted_at) throw new NotFoundError('file_node', body.nodeId);

          const canEditSource = await hasAccess(db, source, 'edit', actor);
          if (!canEditSource) throw new AuthorizationError('No permission to move this resource');

          const placement = await resolvePlacement(db, actor, {
            targetParentId: body.targetParentId,
            scope: body.scope,
            scopeRef: body.scopeRef,
            taskId: body.taskId,
          });

          if (placement.teamId !== source.team_id) {
            throw new AuthorizationError('Cross-team move is not allowed');
          }
          await assertNotMoveIntoDescendant(db, source.id, placement.parentId);

          const targetName = normalizeOptionalName(body.newName, source.name);

          await db.query(
            `WITH RECURSIVE subtree AS (
               SELECT id
                 FROM file_nodes
                WHERE id = $1
               UNION ALL
               SELECT c.id
                 FROM file_nodes c
                 JOIN subtree s ON c.parent_id = s.id
                WHERE c.deleted_at IS NULL
             )
             UPDATE file_nodes
                SET team_id = $2,
                    scope = $3,
                    scope_ref = $4::uuid,
                    updated_at = NOW()
              WHERE id IN (SELECT id FROM subtree)`,
            [source.id, placement.teamId, placement.scope, placement.scopeRef],
          );

          const movedRes = await db.query<FileNodeRow>(
            `UPDATE file_nodes
                SET parent_id = $2,
                    name = $3,
                    team_id = $4,
                    scope = $5,
                    scope_ref = $6::uuid,
                    updated_at = NOW()
              WHERE id = $1
              RETURNING id, team_id, parent_id, scope, scope_ref, kind, name, mime_type, size_bytes, storage_key,
                        metadata, created_by_actor_type, created_by_actor_id, created_at, updated_at, deleted_at`,
            [source.id, placement.parentId, targetName, placement.teamId, placement.scope, placement.scopeRef],
          );
          const moved = movedRes.rows[0];

          await db.query(
            `INSERT INTO resource_events (resource_id, event_type, actor_type, actor_id, payload)
             VALUES ($1, 'resource_moved', $2, $3, $4::jsonb)`,
            [
              moved.id,
              actor.actorType,
              actor.actorId,
              JSON.stringify({
                fromParentId: source.parent_id,
                toParentId: placement.parentId,
                fromScope: source.scope,
                toScope: placement.scope,
                fromScopeRef: source.scope_ref,
                toScopeRef: placement.scopeRef,
              }),
            ],
          );

          return reply.send({
            success: true,
            data: {
              node: mapNode(moved),
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ---------------------------------------------------------------------
    // POST /copy
    // ---------------------------------------------------------------------
    fastify.post<{ Body: CopyNodeBody }>(
      '/copy',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const body = request.body || ({} as CopyNodeBody);
          if (!body.sourceNodeId) throw new ValidationError('sourceNodeId is required');

          const source = await findNodeById(db, body.sourceNodeId);
          if (!source || source.deleted_at) throw new NotFoundError('file_node', body.sourceNodeId);

          const canReadSource = await hasAccess(db, source, 'view', actor);
          if (!canReadSource) throw new AuthorizationError('No permission to copy this resource');

          const placement = await resolvePlacement(db, actor, {
            targetParentId: body.targetParentId,
            scope: body.scope,
            scopeRef: body.scopeRef,
            taskId: body.taskId,
          });
          if (placement.teamId !== source.team_id) {
            throw new AuthorizationError('Cross-team copy is not allowed');
          }

          const targetName = normalizeOptionalName(body.newName, source.name);
          const copied = await cloneNodeTree(db, source, actor, {
            ...placement,
            name: targetName,
          });

          await db.query(
            `INSERT INTO resource_events (resource_id, event_type, actor_type, actor_id, payload)
             VALUES ($1, 'resource_copied', $2, $3, $4::jsonb)`,
            [
              copied.id,
              actor.actorType,
              actor.actorId,
              JSON.stringify({
                sourceNodeId: source.id,
                targetParentId: placement.parentId,
                scope: placement.scope,
                scopeRef: placement.scopeRef,
              }),
            ],
          );

          return reply.status(201).send({
            success: true,
            data: {
              node: mapNode(copied),
              sourceNodeId: source.id,
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ---------------------------------------------------------------------
    // GET /acl/:nodeId
    // ---------------------------------------------------------------------
    fastify.get<{ Params: AclParams }>(
      '/acl/:nodeId',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const node = await findNodeById(db, request.params.nodeId);
          if (!node || node.deleted_at) throw new NotFoundError('file_node', request.params.nodeId);

          const canManage = await hasAccess(db, node, 'manage', actor);
          if (!canManage) throw new AuthorizationError('No permission to read ACL');

          const aclRows = await getAclRows(db, node.id);
          return reply.send({
            success: true,
            data: {
              nodeId: node.id,
              entries: aclRows.map((row) => ({
                id: row.id,
                resourceId: row.resource_id,
                subjectType: row.subject_type,
                subjectId: row.subject_id,
                permission: row.permission,
                effect: row.effect,
              })),
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ---------------------------------------------------------------------
    // POST /acl/grant
    // ---------------------------------------------------------------------
    fastify.post<{ Body: GrantAclBody }>(
      '/acl/grant',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const body = request.body || ({} as GrantAclBody);
          if (!body.nodeId) throw new ValidationError('nodeId is required');
          if (!body.subjectId || !body.subjectId.trim()) throw new ValidationError('subjectId is required');
          if (!body.permission) throw new ValidationError('permission is required');
          if (!body.subjectType) throw new ValidationError('subjectType is required');

          const effect: AclEffect = body.effect || 'allow';
          if (!['allow', 'deny'].includes(effect)) {
            throw new ValidationError('effect must be allow or deny');
          }

          const node = await findNodeById(db, body.nodeId);
          if (!node || node.deleted_at) throw new NotFoundError('file_node', body.nodeId);

          const canManage = await hasAccess(db, node, 'manage', actor);
          if (!canManage) throw new AuthorizationError('No permission to update ACL');

          const insertRes = await db.query<{ id: string }>(
            `INSERT INTO file_acl_entries (
                resource_id, subject_type, subject_id, permission, effect, created_by_actor_type, created_by_actor_id
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7::uuid)
             ON CONFLICT(resource_id, subject_type, subject_id, permission, effect)
             DO NOTHING
             RETURNING id`,
            [
              node.id,
              body.subjectType,
              body.subjectId.trim(),
              body.permission,
              effect,
              actor.actorType,
              actor.actorId,
            ],
          );

          await db.query(
            `INSERT INTO resource_events (resource_id, event_type, actor_type, actor_id, payload)
             VALUES ($1, 'acl_granted', $2, $3, $4::jsonb)`,
            [
              node.id,
              actor.actorType,
              actor.actorId,
              JSON.stringify({
                subjectType: body.subjectType,
                subjectId: body.subjectId.trim(),
                permission: body.permission,
                effect,
                applied: (insertRes.rowCount ?? 0) > 0,
              }),
            ],
          );

          return reply.send({
            success: true,
            data: {
              nodeId: node.id,
              applied: (insertRes.rowCount ?? 0) > 0,
              entry: {
                subjectType: body.subjectType,
                subjectId: body.subjectId.trim(),
                permission: body.permission,
                effect,
              },
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ---------------------------------------------------------------------
    // POST /acl/revoke
    // ---------------------------------------------------------------------
    fastify.post<{ Body: RevokeAclBody }>(
      '/acl/revoke',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const body = request.body || ({} as RevokeAclBody);
          if (!body.nodeId) throw new ValidationError('nodeId is required');
          if (!body.subjectType) throw new ValidationError('subjectType is required');
          if (!body.subjectId || !body.subjectId.trim()) throw new ValidationError('subjectId is required');

          const node = await findNodeById(db, body.nodeId);
          if (!node || node.deleted_at) throw new NotFoundError('file_node', body.nodeId);

          const canManage = await hasAccess(db, node, 'manage', actor);
          if (!canManage) throw new AuthorizationError('No permission to update ACL');

          const conditions: string[] = [
            'resource_id = $1',
            'subject_type = $2',
            'subject_id = $3',
          ];
          const params: unknown[] = [node.id, body.subjectType, body.subjectId.trim()];

          if (body.permission) {
            conditions.push(`permission = $${params.length + 1}`);
            params.push(body.permission);
          }
          if (body.effect) {
            conditions.push(`effect = $${params.length + 1}`);
            params.push(body.effect);
          }

          const deleteSql = `
            DELETE FROM file_acl_entries
             WHERE ${conditions.join(' AND ')}
             RETURNING id
          `;
          const deleteRes = await db.query<{ id: string }>(deleteSql, params);

          await db.query(
            `INSERT INTO resource_events (resource_id, event_type, actor_type, actor_id, payload)
             VALUES ($1, 'acl_revoked', $2, $3, $4::jsonb)`,
            [
              node.id,
              actor.actorType,
              actor.actorId,
              JSON.stringify({
                subjectType: body.subjectType,
                subjectId: body.subjectId.trim(),
                permission: body.permission || null,
                effect: body.effect || null,
                removed: deleteRes.rowCount ?? 0,
              }),
            ],
          );

          return reply.send({
            success: true,
            data: {
              nodeId: node.id,
              removed: deleteRes.rowCount ?? 0,
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ---------------------------------------------------------------------
    // DELETE /:nodeId
    // ---------------------------------------------------------------------
    fastify.delete<{ Params: NodeParams }>(
      '/:nodeId',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const node = await findNodeById(db, request.params.nodeId);
          if (!node || node.deleted_at) throw new NotFoundError('file_node', request.params.nodeId);

          const canEdit = await hasAccess(db, node, 'edit', actor);
          if (!canEdit) throw new AuthorizationError('No permission to delete this resource');

          const deleteRes = await db.query<{ id: string }>(
            `WITH RECURSIVE subtree AS (
               SELECT id
                 FROM file_nodes
                WHERE id = $1
               UNION ALL
               SELECT c.id
                 FROM file_nodes c
                 JOIN subtree s ON c.parent_id = s.id
                WHERE c.deleted_at IS NULL
             )
             UPDATE file_nodes
                SET deleted_at = NOW(),
                    updated_at = NOW()
              WHERE id IN (SELECT id FROM subtree)
                AND deleted_at IS NULL
             RETURNING id`,
            [node.id],
          );

          await db.query(
            `INSERT INTO resource_events (resource_id, event_type, actor_type, actor_id, payload)
             VALUES ($1, 'resource_deleted', $2, $3, $4::jsonb)`,
            [
              node.id,
              actor.actorType,
              actor.actorId,
              JSON.stringify({
                deletedCount: deleteRes.rowCount ?? 0,
              }),
            ],
          );

          return reply.send({
            success: true,
            data: {
              nodeId: node.id,
              deletedCount: deleteRes.rowCount ?? 0,
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ---------------------------------------------------------------------
    // GET /:nodeId
    // ---------------------------------------------------------------------
    fastify.get<{ Params: NodeParams }>(
      '/:nodeId',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const node = await findNodeById(db, request.params.nodeId);
          if (!node || node.deleted_at) throw new NotFoundError('file_node', request.params.nodeId);

          const canRead = await hasAccess(db, node, 'view', actor);
          if (!canRead) throw new AuthorizationError('No permission to access this resource');

          return reply.send({
            success: true,
            data: { node: mapNode(node) },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ---------------------------------------------------------------------
    // POST /publish
    // ---------------------------------------------------------------------
    fastify.post<{ Body: PublishBody }>(
      '/publish',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const actor = await resolveActorContext(db, request);
          const body = request.body || ({} as PublishBody);
          if (!body.sourceNodeId) throw new ValidationError('sourceNodeId is required');

          const source = await findNodeById(db, body.sourceNodeId);
          if (!source || source.deleted_at) throw new NotFoundError('file_node', body.sourceNodeId);
          const canReadSource = await hasAccess(db, source, 'view', actor);
          if (!canReadSource) throw new AuthorizationError('No permission to publish this source node');

          const taskId = body.taskId || (source.scope === 'task' ? source.scope_ref : null);
          if (!taskId) {
            throw new ValidationError('taskId is required for publish when source scope is not task');
          }
          if (!isUuid(taskId)) {
            throw new ValidationError('taskId must be a valid UUID');
          }

          const canPublish = await canPublishForTask(db, taskId, actor);
          if (!canPublish) {
            throw new AuthorizationError('Only delegator chain can publish task outputs');
          }

          const metadata = {
            ...(source.metadata || {}),
            publishedFromNodeId: source.id,
            sourceScope: source.scope,
            sourceScopeRef: source.scope_ref,
            targetPath: body.targetPath || '',
            taskId,
          };

          const createdRes = await db.query<FileNodeRow>(
            `INSERT INTO file_nodes (
                team_id, parent_id, scope, scope_ref, kind, name, mime_type, size_bytes, storage_key, metadata,
                created_by_actor_type, created_by_actor_id
             )
             VALUES ($1, NULL, 'team_shared', NULL, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::uuid)
             RETURNING id, team_id, parent_id, scope, scope_ref, kind, name, mime_type, size_bytes, storage_key,
                       metadata, created_by_actor_type, created_by_actor_id, created_at, updated_at, deleted_at`,
            [
              source.team_id,
              source.kind,
              source.name,
              source.mime_type,
              source.size_bytes,
              source.storage_key,
              JSON.stringify(metadata),
              actor.actorType,
              actor.actorId,
            ],
          );
          const published = createdRes.rows[0];

          // 文档内容复制（仅 doc）
          if (source.kind === 'doc') {
            const latestDoc = await db.query<{ revision: number; raw_text_snapshot: string }>(
              `SELECT revision, raw_text_snapshot
                 FROM doc_contents
                WHERE doc_id = $1
                ORDER BY revision DESC
                LIMIT 1`,
              [source.id],
            );
            if ((latestDoc.rowCount ?? 0) > 0) {
              await db.query(
                `INSERT INTO doc_contents (doc_id, revision, raw_text_snapshot, updated_at)
                 VALUES ($1, 1, $2, NOW())`,
                [published.id, latestDoc.rows[0].raw_text_snapshot || ''],
              );
            }
          }

          // 文件对象映射复制（仅 file）
          if (source.kind === 'file') {
            const blobRes = await db.query<{
              storage_provider: string;
              storage_key: string;
              size_bytes: string;
              checksum_sha256: string | null;
              metadata: Record<string, unknown>;
            }>(
              `SELECT storage_provider, storage_key, size_bytes, checksum_sha256, metadata
                 FROM file_blobs
                WHERE node_id = $1
                LIMIT 1`,
              [source.id],
            );
            if ((blobRes.rowCount ?? 0) > 0) {
              const b = blobRes.rows[0];
              await db.query(
                `INSERT INTO file_blobs (node_id, storage_provider, storage_key, size_bytes, checksum_sha256, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
                [
                  published.id,
                  b.storage_provider,
                  b.storage_key,
                  b.size_bytes,
                  b.checksum_sha256,
                  JSON.stringify(b.metadata || {}),
                ],
              );
            }
          }

          await db.query(
            `INSERT INTO resource_events (resource_id, event_type, actor_type, actor_id, payload)
             VALUES ($1, 'resource_published', $2, $3, $4::jsonb)`,
            [published.id, actor.actorType, actor.actorId, JSON.stringify({ sourceNodeId: source.id, taskId, targetPath: body.targetPath || '' })],
          );

          return reply.status(201).send({
            success: true,
            data: {
              node: mapNode(published),
              sourceNodeId: source.id,
              taskId,
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );
  };
}
