import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { Task, Message } from '@/lib/types';
import { StatusBadge } from './StatusBadge';
import { TaskFlow, BotAvatar } from './BotAvatar';
import { formatDate } from '@/lib/utils';
import { useI18n, trGlobal as trG, termGlobal as termG } from '@/lib/i18n';

interface TaskTimelineProps {
  focusTaskId: string;
  focusTaskStatus?: Task['status'];
  focusTaskPriority?: Task['priority'];
  tasks: Task[];
  messages: Message[];
  /** Called when the right-side detail panel opens or closes */
  onPanelChange?: (open: boolean) => void;
}

const ACTIVITY_VISIBLE_MESSAGE_ROWS = 10;
const ACTIVITY_ROW_EST_PX = 84;

/* ---------- helpers ---------- */

type ActivityItem =
  | { kind: 'task'; createdAt: string; task: Task; children: ActivityItem[] }
  | { kind: 'message'; createdAt: string; message: Message };

const typeBadgeColors: Record<string, string> = {
  direct_message: 'bg-blue-100 text-blue-800',
  task_notification: 'bg-purple-100 text-purple-800',
  delegate_intent: 'bg-sky-100 text-sky-800',
  broadcast: 'bg-green-100 text-green-800',
  system: 'bg-gray-100 text-gray-800',
  human_input_request: 'bg-amber-100 text-amber-800',
  human_input_response: 'bg-emerald-100 text-emerald-800',
  task_continuation: 'bg-green-100 text-green-800',
};

/** Map task.type to action label */
function taskActionLabel(type?: string): { label: string; className: string } {
  if (type === 'sub-task') return { label: trG('子任务', 'Sub-task'), className: 'bg-indigo-50 text-indigo-700' };
  return { label: termG('delegate'), className: 'bg-blue-50 text-blue-700' };
}

/** Map message.type to action label */
function messageActionLabel(type: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    direct_message:       { label: trG('私信', 'Direct Message'), className: 'bg-blue-50 text-blue-700 border-blue-200' },
    task_notification:    { label: trG('通知', 'Notification'), className: 'bg-purple-50 text-purple-700 border-purple-200' },
    delegate_intent:      { label: trG('意图', 'Intent'), className: 'bg-sky-50 text-sky-700 border-sky-200' },
    broadcast:            { label: trG('广播', 'Broadcast'), className: 'bg-green-50 text-green-700 border-green-200' },
    system:               { label: trG('系统', 'System'), className: 'bg-gray-50 text-gray-700 border-gray-200' },
    human_input_request:  { label: trG('人工请求', 'Human Request'), className: 'bg-amber-50 text-amber-700 border-amber-200' },
    human_input_response: { label: trG('人工回复', 'Human Response'), className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    task_continuation:    { label: trG('继续任务', 'Continue Task'), className: 'bg-green-50 text-green-700 border-green-200' },
  };
  return map[type] || { label: trG('消息', 'Message'), className: 'bg-green-50 text-green-700 border-green-200' };
}

function renderContent(content: any): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.text) return parsed.text;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return content;
    }
  }
  if (typeof content === 'object' && content.text) return content.text;
  return JSON.stringify(content, null, 2);
}

interface ParsedMessagePayload {
  text: string;
  raw: Record<string, any> | null;
  submittedResult?: unknown;
  approvedResult?: unknown;
  rejectionReason?: string;
  changeRequest?: string;
  reviewAction?: 'approved' | 'changes_requested' | 'rejected';
}

function parseMessagePayload(content: any): ParsedMessagePayload {
  let raw: Record<string, any> | null = null;
  if (content && typeof content === 'object') {
    raw = content as Record<string, any>;
  } else if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        raw = parsed as Record<string, any>;
      }
    } catch {
      // ignore
    }
  }

  const text = raw?.text
    ? String(raw.text)
    : renderContent(content);

  const reviewAction = raw?.reviewAction === 'approved'
    || raw?.reviewAction === 'changes_requested'
    || raw?.reviewAction === 'rejected'
    ? raw.reviewAction
    : undefined;

  return {
    text,
    raw,
    submittedResult: raw?.submittedResult,
    approvedResult: raw?.approvedResult,
    rejectionReason: raw?.rejectionReason,
    changeRequest: typeof raw?.changeRequest === 'string' ? raw.changeRequest : undefined,
    reviewAction,
  };
}

function formatValueForPreview(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const obj = value as Record<string, any>;
    if (typeof obj.summary === 'string' && obj.summary.trim()) {
      return obj.summary.trim();
    }
  }
  return summarize(value, 180);
}

function summarize(value: unknown, maxLen = 120): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

function formatElapsedClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

function normalizePreviewText(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^\[(Human Input for Task|Task Continuation for|Need Human Input|Human Reply|Task Continued|Task Pending Review|Task Review Approved|Task Review Changes Requested|Task Review Rejected)[^\]]*\]\s*/i, '');
  text = text.replace(/Please continue working on the task(?: with these updated instructions| using this information)\.?$/i, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeBotIdList(...values: unknown[]): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) ids.add(trimmed);
    }
  }
  return Array.from(ids);
}

function normalizeParticipantBots(...values: unknown[]): Array<{ botId: string; botName?: string; botOwner?: string }> {
  const out: Array<{ botId: string; botName?: string; botOwner?: string }> = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const botId = firstNonEmptyString(rec.botId);
      if (!botId || seen.has(botId)) continue;
      seen.add(botId);
      const botName = firstNonEmptyString(rec.botName);
      const botOwner = firstNonEmptyString(rec.botOwner);
      out.push({
        botId,
        ...(botName ? { botName } : {}),
        ...(botOwner ? { botOwner } : {}),
      });
    }
  }
  return out;
}

interface DelegateIntentMeta {
  source: string;
  toBotId: string;
  toBotName: string;
  toBotOwner: string;
  prompt: string;
  participantBotIds: string[];
  participantBots: Array<{ botId: string; botName?: string; botOwner?: string }>;
}

function getDelegateIntentMeta(payload: ParsedMessagePayload): DelegateIntentMeta {
  const raw = payload.raw || {};
  const params = raw.parameters && typeof raw.parameters === 'object'
    ? raw.parameters as Record<string, any>
    : {};
  const delegateIntent = params.delegateIntent && typeof params.delegateIntent === 'object'
    ? params.delegateIntent as Record<string, any>
    : {};
  const collaboration = params.collaboration && typeof params.collaboration === 'object'
    ? params.collaboration as Record<string, any>
    : {};

  return {
    source: firstNonEmptyString(
      raw.source,
      raw.intentSource,
      delegateIntent.source,
    ),
    toBotId: firstNonEmptyString(raw.toBotId, delegateIntent.toBotId),
    toBotName: firstNonEmptyString(raw.toBotName, delegateIntent.toBotName),
    toBotOwner: firstNonEmptyString(raw.toBotOwner, delegateIntent.toBotOwner),
    prompt: firstNonEmptyString(raw.prompt, raw.intent, raw.label),
    participantBotIds: normalizeBotIdList(
      raw.participantBotIds,
      delegateIntent.participantBotIds,
      collaboration.participantBotIds,
    ),
    participantBots: normalizeParticipantBots(
      raw.participantBots,
      delegateIntent.participantBots,
      collaboration.participantBots,
    ),
  };
}

interface HumanInterventionMeta {
  label: string;
  description: string;
}

function isDelegateIntentMessage(msg: Message): boolean {
  return String(msg.type) === 'delegate_intent';
}

function getHumanInterventionMeta(msg: Message, payload: ParsedMessagePayload): HumanInterventionMeta | null {
  const text = payload.text.trim();
  if (msg.type === 'human_input_response' || /^\[Human Reply\]/i.test(text)) {
    return {
      label: trG('人工回复', 'Human Reply'),
      description: trG('人工输入已从仪表盘提交，并回传到机器人会话。', 'Human input was submitted from dashboard and sent back to the bot session.'),
    };
  }
  if (msg.type === 'task_continuation' || /^\[Task Continued\]/i.test(text) || /^\[Task Continuation for/i.test(text)) {
    return {
      label: trG('人工更新', 'Human Update'),
      description: trG('人工从仪表盘提供了新指令以继续该任务。', 'Human provided new instructions from dashboard to continue the task.'),
    };
  }
  if (isDelegateIntentMessage(msg)) {
    const delegateMeta = getDelegateIntentMeta(payload);
    const fromDashboard = /dashboard/i.test(delegateMeta.source);
    return {
      label: fromDashboard ? trG('人工意图', 'Human Intent') : trG('手动意图', 'Manual Intent'),
      description: fromDashboard
        ? trG('该任务意图由人工在仪表盘发起。', 'This task intent was initiated by human from dashboard.')
        : trG('该任务意图由人工创建并通过委托方会话路由。', 'This task intent was created by human and routed through delegator session.'),
    };
  }
  if (/^\[Human Input for Task/i.test(text)) {
    return {
      label: trG('人工输入', 'Human Input'),
      description: trG('人工提供的上下文已转发给机器人作为协作输入。', 'Human-provided context was forwarded to the bot for collaboration.'),
    };
  }
  return null;
}

function isHumanInputRequest(msg: Message, payload: ParsedMessagePayload): boolean {
  return msg.type === 'human_input_request' || /^\[Need Human Input\]/i.test(payload.text.trim());
}

function isHumanInvolvedMessage(msg: Message, payload: ParsedMessagePayload): boolean {
  return Boolean(getHumanInterventionMeta(msg, payload) || isHumanInputRequest(msg, payload));
}

function messagePreview(msg: Message, payload?: ParsedMessagePayload): string {
  const parsed = payload || parseMessagePayload(msg.content);
  if (isDelegateIntentMessage(msg)) {
    const delegateMeta = getDelegateIntentMeta(parsed);
    const target = delegateMeta.toBotName || delegateMeta.toBotId;
    if (target) {
      const prefix = /dashboard/i.test(delegateMeta.source) ? trG('仪表盘意图', 'Dashboard Intent') : trG('委托意图', 'Delegate Intent');
      const rosterSize = delegateMeta.participantBotIds.length;
      if (rosterSize > 1) {
        return trG(`${prefix}: 发给 ${target}（${rosterSize} 个参与者）`, `${prefix}: to ${target} (${rosterSize} participants)`);
      }
      return trG(`${prefix}: 发给 ${target}`, `${prefix}: to ${target}`);
    }
    if (delegateMeta.participantBotIds.length > 0) {
      const prefix = /dashboard/i.test(delegateMeta.source) ? trG('仪表盘意图', 'Dashboard Intent') : trG('委托意图', 'Delegate Intent');
      return trG(`${prefix}: ${delegateMeta.participantBotIds.length} 个参与者`, `${prefix}: ${delegateMeta.participantBotIds.length} participants`);
    }
    if (delegateMeta.prompt) {
      return trG(`委托意图: ${normalizePreviewText(delegateMeta.prompt)}`, `Delegate Intent: ${normalizePreviewText(delegateMeta.prompt)}`);
    }
    return trG('已创建委托意图', 'Delegate intent created');
  }

  if (isHumanInputRequest(msg, parsed)) {
    const reason = normalizePreviewText(parsed.text);
    return reason ? trG(`需要人工输入: ${reason}`, `Needs human input: ${reason}`) : trG('需要人工输入', 'Needs human input');
  }

  const humanIntervention = getHumanInterventionMeta(msg, parsed);
  if (humanIntervention && !isDelegateIntentMessage(msg)) {
    const detail = normalizePreviewText(parsed.text);
    if (detail) return `${humanIntervention.label.toLowerCase()}: ${detail}`;
  }

  if (parsed.reviewAction === 'changes_requested') {
    const feedback = (parsed.changeRequest || parsed.rejectionReason || normalizePreviewText(parsed.text) || trG('请修改后重提', 'Please revise and resubmit')).trim();
    return trG(`要求修改: ${feedback}`, `Changes requested: ${feedback}`);
  }
  if (parsed.reviewAction === 'rejected') {
    const reason = (parsed.rejectionReason || normalizePreviewText(parsed.text) || trG('已拒绝', 'Rejected')).trim();
    return trG(`要求返工: ${reason}`, `Rework required: ${reason}`);
  }
  if (parsed.reviewAction === 'approved') {
    const approved = formatValueForPreview(parsed.approvedResult);
    return approved ? trG(`已批准结果: ${approved}`, `Approved result: ${approved}`) : trG('任务已被委托方批准', 'Task approved by delegator');
  }
  if (parsed.submittedResult !== undefined) {
    const submitted = formatValueForPreview(parsed.submittedResult);
    return submitted ? trG(`提交结果: ${submitted}`, `Submitted result: ${submitted}`) : trG('执行方已提交结果等待审核', 'Executor submitted result, waiting for review');
  }

  const normalized = normalizePreviewText(parsed.text);
  if (!normalized) return trG('（无内容）', '(empty)');
  return normalized.length > 180 ? `${normalized.slice(0, 180)}...` : normalized;
}

type MessageVisualKind = 'normal' | 'submitted' | 'approved' | 'changes_requested' | 'rejected';

function getMessageVisualKind(msg: Message, payload?: ParsedMessagePayload): MessageVisualKind {
  const parsed = payload || parseMessagePayload(msg.content);
  if (parsed.reviewAction === 'approved') return 'approved';
  if (parsed.reviewAction === 'changes_requested') return 'changes_requested';
  if (parsed.reviewAction === 'rejected') return 'rejected';
  if (parsed.submittedResult !== undefined) return 'submitted';
  return 'normal';
}

function ts(dateStr: string) {
  return new Date(dateStr).getTime();
}

function buildSyntheticApprovedMessage(task: Task): Message {
  const createdAt = task.completedAt || task.submittedAt || task.createdAt;
  return {
    messageId: `synthetic-review-approved-${task.id}`,
    fromBotId: task.fromBotId,
    toBotId: task.toBotId,
    type: 'system',
    contentType: 'json',
    content: {
      text:
        `[Task Review Approved]\n\n` +
        trG(`任务 ${task.id} 已由委托方 ${task.fromBotId} 批准。`, `Task ${task.id} was approved by delegator ${task.fromBotId}.`),
      reviewAction: 'approved',
      approvedResult: task.result ?? task.submittedResult ?? null,
      source: 'synthetic_fallback',
    },
    priority: 'high',
    status: 'delivered',
    taskId: task.id,
    traceId: `synthetic-review-approved-${task.id}`,
    createdAt,
    readAt: null,
    fromBotName: task.fromBotName,
    fromAvatarColor: task.fromAvatarColor,
    fromAvatarUrl: task.fromAvatarUrl,
    toBotName: task.toBotName,
    toAvatarColor: task.toAvatarColor,
    toAvatarUrl: task.toAvatarUrl,
  };
}

function buildSyntheticRejectedMessage(task: Task): Message {
  const createdAt = task.submittedAt || task.startedAt || task.createdAt;
  return {
    messageId: `synthetic-review-rejected-${task.id}`,
    fromBotId: task.fromBotId,
    toBotId: task.toBotId,
    type: 'system',
    contentType: 'json',
    content: {
      text:
        `[Task Review Rejected]\n\n` +
        trG(`任务 ${task.id} 已被委托方 ${task.fromBotId} 拒绝。`, `Task ${task.id} was rejected by delegator ${task.fromBotId}.`),
      reviewAction: 'rejected',
      rejectionReason: task.rejectionReason || trG('已拒绝', 'Rejected'),
      source: 'synthetic_fallback',
    },
    priority: 'high',
    status: 'delivered',
    taskId: task.id,
    traceId: `synthetic-review-rejected-${task.id}`,
    createdAt,
    readAt: null,
    fromBotName: task.fromBotName,
    fromAvatarColor: task.fromAvatarColor,
    fromAvatarUrl: task.fromAvatarUrl,
    toBotName: task.toBotName,
    toAvatarColor: task.toAvatarColor,
    toAvatarUrl: task.toAvatarUrl,
  };
}

/* ---------- tree builder ---------- */

function buildActivityTree(
  taskId: string,
  taskMap: Map<string, Task>,
  childrenMap: Map<string, string[]>,
  msgByTask: Map<string, Message[]>,
  depth: number,
): ActivityItem | null {
  if (depth > 20) return null;
  const task = taskMap.get(taskId);
  if (!task) return null;

  const children: ActivityItem[] = [];
  const childIds = childrenMap.get(taskId) || [];
  for (const cid of childIds) {
    const node = buildActivityTree(cid, taskMap, childrenMap, msgByTask, depth + 1);
    if (node) children.push(node);
  }
  const msgs = msgByTask.get(taskId) || [];
  for (const m of msgs) {
    children.push({ kind: 'message', createdAt: m.createdAt, message: m });
  }
  children.sort((a, b) => ts(a.createdAt) - ts(b.createdAt));

  return { kind: 'task', createdAt: task.createdAt, task, children };
}

function collectPathIds(
  root: ActivityItem,
  targetId: string,
  path: string[] = [],
): string[] | null {
  if (root.kind !== 'task') return null;
  const current = [...path, root.task.id];
  if (root.task.id === targetId) return current;
  for (const child of root.children) {
    const found = collectPathIds(child, targetId, current);
    if (found) return found;
  }
  return null;
}

/* ---------- icons ---------- */

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function HumanIcon({ className = 'w-3 h-3' }: { className?: string }) {
  const classes = `text-red-600 ${className}`.trim();
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={classes}
      aria-hidden="true"
    >
      <circle cx="12" cy="7.5" r="3.5" />
      <path d="M4.5 20c1.2-3.8 4.2-6 7.5-6s6.3 2.2 7.5 6" />
    </svg>
  );
}

/* ---------- detail panel ---------- */

function MessageDetailPanel({ msg, onClose }: { msg: Message; onClose: () => void }) {
  const { tr, term } = useI18n();
  const payload = parseMessagePayload(msg.content);
  const contentText = payload.text;
  const visualKind = getMessageVisualKind(msg, payload);
  const humanIntervention = getHumanInterventionMeta(msg, payload);
  const needHuman = isHumanInputRequest(msg, payload);
  const humanInvolved = isHumanInvolvedMessage(msg, payload);
  const delegateIntentMeta = isDelegateIntentMessage(msg) ? getDelegateIntentMeta(payload) : null;

  return (
    <div className="h-full w-full rounded-xl glass-strong overflow-hidden flex flex-col border border-gray-200">
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-3 ${
        visualKind === 'submitted'
          ? 'bg-indigo-50'
          : visualKind === 'approved'
            ? 'bg-emerald-50'
            : visualKind === 'changes_requested'
              ? 'bg-amber-50'
            : visualKind === 'rejected'
              ? 'bg-rose-50'
              : 'bg-green-50'
      }`}>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700">
            MSG
          </span>
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${typeBadgeColors[msg.type] || 'bg-gray-100 text-gray-800'}`}>
            {msg.type}
          </span>
          {visualKind === 'submitted' && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-100 text-indigo-700">
              Submitted Result
            </span>
          )}
          {visualKind === 'approved' && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">
              Approved
            </span>
          )}
          {visualKind === 'changes_requested' && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
              Changes Requested
            </span>
          )}
          {visualKind === 'rejected' && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-rose-100 text-rose-700">
              Rejected
            </span>
          )}
          {needHuman && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
              <HumanIcon className="w-3 h-3" />
              Needs Human
            </span>
          )}
          {humanIntervention && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-cyan-100 text-cyan-700">
              <HumanIcon className="w-3 h-3" />
              {humanIntervention.label}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-green-100 text-gray-500 hover:text-gray-700 transition-colors"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Body */}
      <div className="p-4 space-y-4 overflow-y-auto max-h-[70vh]">
        {/* Badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={msg.priority} />
          <StatusBadge status={msg.status} />
          {humanInvolved && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border border-cyan-200 bg-cyan-50 text-cyan-700">
              <HumanIcon className="w-3 h-3" />
              {tr('人工参与', 'Human Involved')}
            </span>
          )}
        </div>

        {needHuman && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <p className="text-xs font-semibold text-amber-800 flex items-center gap-1.5">
              <HumanIcon className="w-3.5 h-3.5" />
              {tr('需要人工关注', 'Needs Human Attention')}
            </p>
            <p className="text-xs text-amber-700 mt-1">
              {tr('该步骤正在等待人工澄清，机器人才能继续执行。', `This step is waiting for human clarification before the ${term('bot')} can continue.`)}
            </p>
          </div>
        )}

        {humanIntervention && (
          <div className="rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2">
            <p className="text-xs font-semibold text-cyan-800 flex items-center gap-1.5">
              <HumanIcon className="w-3.5 h-3.5" />
              {tr('人工介入', 'Human Intervention')}
            </p>
            <p className="text-xs text-cyan-700 mt-1">{humanIntervention.description}</p>
          </div>
        )}

        {delegateIntentMeta && (
          <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 space-y-1">
            <p className="text-xs font-semibold text-sky-800">{tr('委托意图元数据', 'Delegate Intent Metadata')}</p>
            {delegateIntentMeta.source && (
              <p className="text-xs text-sky-700">
                {tr('来源', 'Source')}: <span className="font-medium">{delegateIntentMeta.source}</span>
              </p>
            )}
            {(delegateIntentMeta.toBotId || delegateIntentMeta.toBotName) && (
              <p className="text-xs text-sky-700">
                {tr('目标执行者', 'Target Executor')}: <span className="font-medium">{delegateIntentMeta.toBotName || delegateIntentMeta.toBotId}</span>
                {delegateIntentMeta.toBotId && delegateIntentMeta.toBotName && (
                  <span className="text-sky-600"> ({delegateIntentMeta.toBotId})</span>
                )}
              </p>
            )}
            {delegateIntentMeta.toBotOwner && (
              <p className="text-xs text-sky-700">
                {tr('目标所有者', 'Target Owner')}: <span className="font-medium">{delegateIntentMeta.toBotOwner}</span>
              </p>
            )}
            {(delegateIntentMeta.participantBotIds.length > 0 || delegateIntentMeta.participantBots.length > 0) && (
              <div className="text-xs text-sky-700">
                <p>
                  {tr('协作参与者', 'Collaboration Participants')}:
                  <span className="font-medium"> {delegateIntentMeta.participantBotIds.length || delegateIntentMeta.participantBots.length}</span>
                </p>
                <div className="mt-1 space-y-0.5">
                  {((delegateIntentMeta.participantBots.length > 0
                    ? delegateIntentMeta.participantBots
                    : delegateIntentMeta.participantBotIds.map((botId) => ({ botId }))
                  ) as Array<{ botId: string; botName?: string; botOwner?: string }>).map((participant) => (
                    <p key={participant.botId} className="font-mono text-[11px] break-all">
                      {participant.botName ? `${participant.botName} (${participant.botId})` : participant.botId}
                      {participant.botOwner ? ` | ${participant.botOwner}` : ''}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* From → To */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <BotAvatar
              name={msg.fromBotName || msg.fromBotId}
              id={msg.fromBotId}
              avatarColor={msg.fromAvatarColor}
              avatarUrl={msg.fromAvatarUrl}
              size="sm"
            />
            <div className="min-w-0">
              <p className="text-xs font-medium text-gray-900 truncate">{msg.fromBotName || msg.fromBotId}</p>
              <p className="text-[10px] text-gray-500">{tr('来源', 'Source')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <BotAvatar
              name={msg.toBotName || msg.toBotId}
              id={msg.toBotId}
              avatarColor={msg.toAvatarColor}
              avatarUrl={msg.toAvatarUrl}
              size="sm"
            />
            <div className="min-w-0">
              <p className="text-xs font-medium text-gray-900 truncate">{msg.toBotName || msg.toBotId}</p>
              <p className="text-[10px] text-gray-500">{tr('目标', 'Target')}</p>
            </div>
          </div>
        </div>

        {/* IDs */}
        <div className="space-y-1.5 text-xs">
          <div>
            <span className="text-gray-500">{tr('消息 ID', 'Message ID')}</span>
            <p className="font-mono bg-gray-50 px-2 py-1 rounded text-gray-700 mt-0.5 break-all">{msg.messageId}</p>
          </div>
          <div>
            <span className="text-gray-500">{tr('追踪 ID', 'Trace ID')}</span>
            <p className="font-mono bg-gray-50 px-2 py-1 rounded text-gray-700 mt-0.5 break-all">{msg.traceId}</p>
          </div>
          <div>
            <span className="text-gray-500">{tr('内容类型', 'Content Type')}</span>
            <p className="font-mono bg-gray-50 px-2 py-1 rounded text-gray-700 mt-0.5">{msg.contentType}</p>
          </div>
        </div>

        {/* Content */}
        {contentText && (
          <div>
            <h4 className="text-xs font-medium text-gray-700 mb-1">{tr('内容', 'Content')}</h4>
            <pre className="bg-gray-50 rounded p-2 text-xs text-gray-900 overflow-x-auto max-h-56 whitespace-pre-wrap break-words">
              {contentText}
            </pre>
          </div>
        )}

        {payload.submittedResult !== undefined && (
          <div>
            <h4 className="text-xs font-medium text-indigo-700 mb-1">{tr('提交结果快照', 'Submitted Result Snapshot')}</h4>
            <pre className="bg-indigo-50 rounded p-2 text-xs text-gray-900 overflow-x-auto max-h-56 whitespace-pre-wrap break-words">
              {typeof payload.submittedResult === 'object'
                ? JSON.stringify(payload.submittedResult, null, 2)
                : String(payload.submittedResult)}
            </pre>
          </div>
        )}

        {payload.approvedResult !== undefined && (
          <div>
            <h4 className="text-xs font-medium text-emerald-700 mb-1">{tr('批准结果快照', 'Approved Result Snapshot')}</h4>
            <pre className="bg-emerald-50 rounded p-2 text-xs text-gray-900 overflow-x-auto max-h-56 whitespace-pre-wrap break-words">
              {typeof payload.approvedResult === 'object'
                ? JSON.stringify(payload.approvedResult, null, 2)
                : String(payload.approvedResult)}
            </pre>
          </div>
        )}

        {payload.rejectionReason && (
          <div>
            <h4 className="text-xs font-medium text-rose-700 mb-1">{tr('拒绝原因', 'Rejection Reason')}</h4>
            <p className="bg-rose-50 rounded p-2 text-xs text-rose-800 whitespace-pre-wrap break-words">
              {payload.rejectionReason}
            </p>
          </div>
        )}

        {payload.changeRequest && (
          <div>
            <h4 className="text-xs font-medium text-amber-700 mb-1">{tr('修改意见', 'Requested Changes')}</h4>
            <p className="bg-amber-50 rounded p-2 text-xs text-amber-800 whitespace-pre-wrap break-words">
              {payload.changeRequest}
            </p>
          </div>
        )}

        {/* Linked task */}
        {msg.taskId && (
          <div>
            <span className="text-xs text-gray-500">{tr(`关联${term('task')}`, `Related ${term('task')}`)}</span>
            <p className="mt-0.5">
              <Link to={`/tasks/${msg.taskId}`} className="font-mono text-xs text-purple-700 hover:underline bg-purple-50 px-2 py-1 rounded inline-block break-all">
                {msg.taskId}
              </Link>
            </p>
          </div>
        )}

        {/* Timestamps */}
        <div className="text-xs text-gray-500 space-y-1 border-t border-gray-100 pt-3">
          <p>{tr('创建时间', 'Created')}: {formatDate(msg.createdAt)}</p>
          {msg.readAt && <p>{tr('已读时间', 'Read at')}: {formatDate(msg.readAt)}</p>}
        </div>
      </div>
    </div>
  );
}

/* ---------- main component ---------- */

export function TaskTimeline({ focusTaskId, focusTaskStatus, focusTaskPriority, tasks, messages, onPanelChange }: TaskTimelineProps) {
  const { tr, term } = useI18n();
  const navigate = useNavigate();
  const activityViewportRef = useRef<HTMLDivElement | null>(null);
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [panelLayout, setPanelLayout] = useState<{ mobile: boolean; top: number; left: number; height: number }>({
    mobile: true,
    top: 96,
    left: 0,
    height: 480,
  });

  const tree = useMemo(() => {
    const taskMap = new Map(tasks.map(t => [t.id, t]));

    let rootId = focusTaskId;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(rootId)) break;
      visited.add(rootId);
      const t = taskMap.get(rootId);
      if (!t?.parentTaskId || !taskMap.has(t.parentTaskId)) break;
      rootId = t.parentTaskId;
    }

    const childrenMap = new Map<string, string[]>();
    for (const t of tasks) {
      if (t.parentTaskId && taskMap.has(t.parentTaskId)) {
        const arr = childrenMap.get(t.parentTaskId) || [];
        arr.push(t.id);
        childrenMap.set(t.parentTaskId, arr);
      }
    }

    const msgByTask = new Map<string, Message[]>();
    const reviewFlags = new Map<string, { approved: boolean; changesRequested: boolean; rejected: boolean }>();
    for (const m of messages) {
      if (m.taskId) {
        const arr = msgByTask.get(m.taskId) || [];
        arr.push(m);
        msgByTask.set(m.taskId, arr);

        const parsed = parseMessagePayload(m.content);
        if (parsed.reviewAction) {
          const current = reviewFlags.get(m.taskId) || { approved: false, changesRequested: false, rejected: false };
          if (parsed.reviewAction === 'approved') current.approved = true;
          if (parsed.reviewAction === 'changes_requested') current.changesRequested = true;
          if (parsed.reviewAction === 'rejected') current.rejected = true;
          reviewFlags.set(m.taskId, current);
        }
      }
    }

    // Compatibility fallback:
    // for historical tasks that do not have persisted reviewAction messages,
    // synthesize review events so APPROVED/REJECTED badges still show in Activity Tree.
    for (const task of tasks) {
      const taskId = task.id;
      const flags = reviewFlags.get(taskId) || { approved: false, changesRequested: false, rejected: false };
      const arr = msgByTask.get(taskId) || [];

      if (task.rejectionReason && !flags.rejected && !flags.changesRequested) {
        arr.push(buildSyntheticRejectedMessage(task));
        flags.rejected = true;
      }

      if (task.status === 'completed' && task.submittedAt && !flags.approved) {
        arr.push(buildSyntheticApprovedMessage(task));
        flags.approved = true;
      }

      if (arr.length > 0) {
        msgByTask.set(taskId, arr);
        reviewFlags.set(taskId, flags);
      }
    }

    return buildActivityTree(rootId, taskMap, childrenMap, msgByTask, 0);
  }, [focusTaskId, tasks, messages]);

  const initialExpanded = useMemo(() => {
    if (!tree || tree.kind !== 'task') return new Set<string>();
    const path = collectPathIds(tree, focusTaskId) || [];
    return new Set(path);
  }, [tree, focusTaskId]);

  const [toggledTasks, setToggledTasks] = useState<Set<string>>(new Set());
  const [selectedMsgId, setSelectedMsgId] = useState<string | null>(null);

  // Build a lookup for all messages in the tree so we can find the selected one
  const msgMap = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.messageId, m);
    return map;
  }, [messages]);

  const selectedMsg = selectedMsgId ? msgMap.get(selectedMsgId) ?? null : null;

  useEffect(() => {
    onPanelChange?.(selectedMsg !== null);
  }, [selectedMsg, onPanelChange]);

  useEffect(() => {
    if (!selectedMsg) return;
    const panelWidth = 22 * 16; // 22rem
    const gap = 12;
    const edge = 16;

    const updatePanelLayout = () => {
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const mobile = viewportW < 1280;

      if (mobile || !timelineRootRef.current) {
        setPanelLayout({
          mobile: true,
          top: 96,
          left: 0,
          height: Math.max(320, viewportH - 120),
        });
        return;
      }

      const rect = timelineRootRef.current.getBoundingClientRect();
      const preferredLeft = rect.right + gap;
      const maxLeft = viewportW - edge - panelWidth;
      const left = Math.min(Math.max(edge, preferredLeft), maxLeft);
      const top = Math.max(24, Math.min(rect.top, viewportH - 320));
      const height = Math.max(300, viewportH - top - 24);

      setPanelLayout({
        mobile: false,
        top,
        left,
        height,
      });
    };

    updatePanelLayout();
    window.addEventListener('resize', updatePanelLayout);
    window.addEventListener('scroll', updatePanelLayout, true);
    return () => {
      window.removeEventListener('resize', updatePanelLayout);
      window.removeEventListener('scroll', updatePanelLayout, true);
    };
  }, [selectedMsg, selectedMsgId, focusTaskId, messages.length]);

  useEffect(() => {
    const viewport = activityViewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [messages.length, focusTaskId]);

  const isTaskExpanded = useCallback(
    (taskId: string) => {
      const defaultExpanded = initialExpanded.has(taskId);
      return toggledTasks.has(taskId) ? !defaultExpanded : defaultExpanded;
    },
    [toggledTasks, initialExpanded],
  );

  const toggleTask = useCallback((taskId: string) => {
    setToggledTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const selectMsg = useCallback((msgId: string) => {
    setSelectedMsgId((prev) => (prev === msgId ? null : msgId));
  }, []);

  if (!tree) {
    return <p className="text-sm text-gray-400">{tr('暂无活动数据', 'No activity data')}</p>;
  }

  /* ---------- render tree nodes ---------- */

  function renderTaskNode(item: ActivityItem & { kind: 'task' }, depth: number) {
    const { task, children } = item;
    const isFocus = task.id === focusTaskId;
    const indent = depth * 24;
    const hasChildren = children.length > 0;
    const expanded = isTaskExpanded(task.id);

    return (
      <div key={`t-${task.id}`}>
        <div
          className={`relative flex items-start gap-2 py-2 px-3 rounded-lg transition-colors ${
            isFocus
              ? 'bg-blue-50'
              : 'hover:bg-gray-50'
          }`}
          style={{ marginLeft: indent }}
        >
          {/* Collapse toggle */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (hasChildren) toggleTask(task.id);
            }}
            className={`mt-1 shrink-0 w-5 h-5 flex items-center justify-center rounded transition-colors ${
              hasChildren
                ? 'text-gray-500 hover:text-gray-800 hover:bg-gray-200 cursor-pointer'
                : 'text-transparent cursor-default'
            }`}
          >
            {hasChildren && <ChevronIcon expanded={expanded} />}
          </button>

          {/* Dot */}
          <div className="flex flex-col items-center pt-1 shrink-0">
            <div className={`w-3 h-3 rounded-full border-2 ${
              isFocus ? 'bg-blue-500 border-blue-300' : 'bg-blue-400 border-blue-200'
            }`} />
            {hasChildren && expanded && (
              <div className="w-0.5 flex-1 bg-gray-200 mt-0.5" />
            )}
          </div>

          {/* Content */}
          <div
            className="flex-1 min-w-0 cursor-pointer"
            onClick={() => navigate(`/tasks/${task.id}`)}
          >
            <div className="flex items-center gap-2 flex-wrap">
              {(() => { const action = taskActionLabel(task.type); return (
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${action.className}`}>
                {action.label}
              </span>
              ); })()}
              <span className="font-medium text-gray-900 text-sm truncate">{task.title || (task.prompt ? (task.prompt.length > 40 ? task.prompt.slice(0, 40) + '...' : task.prompt) : task.capability) || term('task')}</span>
              <StatusBadge status={task.status} />
              <StatusBadge status={task.priority} />
              {hasChildren && (
                <span className="text-[10px] text-gray-500">({children.length})</span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1">
              <TaskFlow
                fromName={task.fromBotName || task.fromBotId}
                fromId={task.fromBotId}
                fromAvatarColor={task.fromAvatarColor}
                fromAvatarUrl={task.fromAvatarUrl}
                toName={task.toBotName || task.toBotId}
                toId={task.toBotId}
                toAvatarColor={task.toAvatarColor}
                toAvatarUrl={task.toAvatarUrl}
                size="sm"
              />
              <span className="text-xs text-gray-500 truncate">
                {task.fromBotName || task.fromBotId.slice(0, 8)} → {task.toBotName || task.toBotId.slice(0, 8)}
              </span>
            </div>
            {Object.keys(task.parameters || {}).length > 0 && (
              <p className="text-xs text-gray-500 truncate mt-1">{tr('参数', 'Parameters')}: {summarize(task.parameters)}</p>
            )}
            {task.error && (
              <p className="text-xs text-red-600 truncate mt-1">{tr('错误', 'Error')}: {summarize(task.error)}</p>
            )}
            {!task.error && task.result !== undefined && task.result !== null && (
              <p className="text-xs text-green-700 truncate mt-1">{tr('结果', 'Result')}: {summarize(task.result)}</p>
            )}
            <p className="text-[10px] text-gray-500 mt-1">{formatDate(task.createdAt)}</p>
          </div>
        </div>

        {hasChildren && expanded && (
          <div className="relative" style={{ marginLeft: indent + 18 }}>
            <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-gray-200" />
            <div className="pl-4 space-y-1 py-1">
              {children.map((child) =>
                child.kind === 'task'
                  ? renderTaskNode(child, 0)
                  : renderMessageNode(child)
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderMessageNode(item: ActivityItem & { kind: 'message' }) {
    const { message: msg } = item;
    const payload = parseMessagePayload(msg.content);
    const contentText = messagePreview(msg, payload);
    const isSelected = selectedMsgId === msg.messageId;
    const visualKind = getMessageVisualKind(msg, payload);
    const humanIntervention = getHumanInterventionMeta(msg, payload);
    const humanInvolved = isHumanInvolvedMessage(msg, payload);

    const fromName = msg.fromBotName || msg.fromBotId.slice(0, 8);
    const toName = msg.toBotName || msg.toBotId.slice(0, 8);

    // Determine row color based on message type
    const isHumanRequest = isHumanInputRequest(msg, payload);
    const isHumanResponse = msg.type === 'human_input_response';
    const rowTone = visualKind === 'submitted'
      ? 'border-indigo-200 bg-indigo-50'
      : visualKind === 'approved'
        ? 'border-emerald-200 bg-emerald-50'
        : visualKind === 'changes_requested'
          ? 'border-amber-200 bg-amber-50'
        : visualKind === 'rejected'
          ? 'border-rose-200 bg-rose-50'
          : isHumanRequest
            ? 'border-amber-200 bg-amber-50'
            : isHumanResponse
              ? 'border-emerald-200 bg-emerald-50'
              : humanIntervention
                ? 'border-cyan-200 bg-cyan-50'
              : 'border-gray-200 bg-gray-50';
    const selectedTone = visualKind === 'submitted'
      ? 'ring-2 ring-indigo-300 border-indigo-300'
      : visualKind === 'approved'
        ? 'ring-2 ring-emerald-300 border-emerald-300'
        : visualKind === 'changes_requested'
          ? 'ring-2 ring-amber-300 border-amber-300'
        : visualKind === 'rejected'
          ? 'ring-2 ring-rose-300 border-rose-300'
          : isHumanRequest
            ? 'ring-2 ring-amber-300 border-amber-300'
            : isHumanResponse
              ? 'ring-2 ring-emerald-300 border-emerald-300'
              : humanIntervention
                ? 'ring-2 ring-cyan-300 border-cyan-300'
              : 'ring-2 ring-primary-300 border-primary-300';

    const actionBadge = messageActionLabel(msg.type);
    const showPriority = msg.priority !== 'normal';
    const eventBadge = visualKind === 'submitted'
      ? { label: tr('已提交', 'Submitted'), className: 'bg-indigo-100 text-indigo-700 border-indigo-200' }
      : visualKind === 'approved'
        ? { label: tr('已批准', 'Approved'), className: 'bg-emerald-100 text-emerald-700 border-emerald-200' }
        : visualKind === 'changes_requested'
          ? { label: tr('需修改', 'Changes Requested'), className: 'bg-amber-100 text-amber-700 border-amber-200' }
        : visualKind === 'rejected'
          ? { label: tr('已拒绝', 'Rejected'), className: 'bg-rose-100 text-rose-700 border-rose-200' }
          : null;
    const humanBadge = humanIntervention
      ? { label: humanIntervention.label, className: 'bg-cyan-100 text-cyan-700 border-cyan-200' }
      : null;
    const needsHumanBadge = isHumanRequest
      ? { label: tr('需要人工', 'Needs Human'), className: 'bg-amber-100 text-amber-700 border-amber-200' }
      : null;

    return (
      <div
        key={`m-${msg.messageId}`}
        onClick={() => selectMsg(msg.messageId)}
        className={`relative flex items-start gap-3 py-2.5 px-3 rounded-xl border cursor-pointer transition-all ${
          isSelected ? `${rowTone} ${selectedTone}` : `${rowTone} hover:shadow-sm`
        }`}
      >
        <BotAvatar
          name={msg.fromBotName || msg.fromBotId}
          id={msg.fromBotId}
          avatarColor={msg.fromAvatarColor}
          avatarUrl={msg.fromAvatarUrl}
          size="sm"
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex items-center gap-1.5">
              {humanInvolved && (
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full border border-red-200 bg-red-50 text-red-600 shrink-0">
                  <HumanIcon className="w-3 h-3" />
                </span>
              )}
              <span className="text-sm font-semibold text-gray-900 truncate">{fromName}</span>
              <span className="text-xs text-gray-500 shrink-0">{tr('给', 'to')}</span>
              <span className="text-xs text-gray-600 truncate">{toName}</span>
            </div>
            <span className="text-[10px] text-gray-500 shrink-0">{formatDate(msg.createdAt)}</span>
          </div>
          <p
            className="mt-1 text-sm text-gray-700 break-words"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {contentText}
          </p>
          <div className="mt-1.5 flex items-center gap-1.5">
            {eventBadge && (
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${eventBadge.className}`}>
                {eventBadge.label}
              </span>
            )}
            {needsHumanBadge && (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${needsHumanBadge.className}`}>
                <HumanIcon className="w-3 h-3" />
                {needsHumanBadge.label}
              </span>
            )}
            {humanBadge && (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${humanBadge.className}`}>
                <HumanIcon className="w-3 h-3" />
                {humanBadge.label}
              </span>
            )}
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${actionBadge.className}`}>
              {actionBadge.label}
            </span>
            {showPriority && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border border-rose-200 bg-rose-50 text-rose-700">
                {msg.priority.toUpperCase()}
              </span>
            )}
            {msg.status === 'read' && (
              <span className="text-[10px] text-gray-500">{tr('已读', 'Read')}</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  const showExecutionLoader =
    focusTaskStatus === 'pending' ||
    focusTaskStatus === 'accepted' ||
    focusTaskStatus === 'processing';
  const focusTask = tasks.find((t) => t.id === focusTaskId) || null;
  let waitingSinceMs: number | null = null;
  if (showExecutionLoader) {
    let latestMessageMs = 0;
    for (const message of messages) {
      if (message.taskId !== focusTaskId) continue;
      const parsed = Date.parse(message.createdAt);
      if (!Number.isNaN(parsed) && parsed > latestMessageMs) latestMessageMs = parsed;
    }
    if (latestMessageMs > 0) {
      waitingSinceMs = latestMessageMs;
    } else if (focusTask?.startedAt) {
      const started = Date.parse(focusTask.startedAt);
      if (!Number.isNaN(started)) waitingSinceMs = started;
    } else if (focusTask?.createdAt) {
      const created = Date.parse(focusTask.createdAt);
      if (!Number.isNaN(created)) waitingSinceMs = created;
    }
  }
  const waitingElapsedText = waitingSinceMs ? formatElapsedClock(nowMs - waitingSinceMs) : '—';
  const executionPriority = focusTaskPriority || 'normal';
  const loaderToneClass =
    executionPriority === 'urgent'
      ? 'task-exec-loader--urgent'
      : executionPriority === 'high'
        ? 'task-exec-loader--high'
        : executionPriority === 'low'
          ? 'task-exec-loader--low'
          : 'task-exec-loader--normal';
  const runningLabel =
    executionPriority === 'urgent'
      ? tr('紧急处理中', 'Urgent Processing')
      : executionPriority === 'high'
        ? tr('高优先处理中', 'High Priority Processing')
        : executionPriority === 'low'
          ? tr('低优先处理中', 'Low Priority Processing')
          : tr('处理中', 'Processing');
  const runningHint =
    executionPriority === 'urgent'
      ? tr('紧急任务执行中，预计很快会有更新...', 'Urgent task is running, updates should come soon...')
      : executionPriority === 'high'
        ? tr('高优先任务执行中，正在等待快速更新...', 'High-priority task is running, waiting for quick updates...')
        : executionPriority === 'low'
          ? tr('低优先任务稳态执行中...', 'Low-priority task is running steadily...')
          : tr('实时执行中，等待机器人新更新...', 'Running in real time, waiting for bot updates...');
  const runningChipTone =
    executionPriority === 'urgent'
      ? 'border-rose-200 bg-rose-100 text-rose-700'
      : executionPriority === 'high'
        ? 'border-amber-200 bg-amber-100 text-amber-800'
        : executionPriority === 'low'
          ? 'border-cyan-200 bg-cyan-100 text-cyan-700'
          : 'border-primary-200 bg-primary-100 text-primary-700';

  useEffect(() => {
    if (!showExecutionLoader || !waitingSinceMs) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [showExecutionLoader, waitingSinceMs]);

  if (tree.kind !== 'task') return null;

  // Skip the root node (the task itself) and render its children directly
  const topLevelItems = tree.children;

  return (
    <div ref={timelineRootRef} className="relative">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border border-cyan-200 bg-cyan-50 text-cyan-700">
          <HumanIcon className="w-3 h-3" />
          {tr('人工介入', 'Human Intervention')}
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border border-amber-200 bg-amber-50 text-amber-700">
          <HumanIcon className="w-3 h-3" />
          {tr('需要人工', 'Needs Human')}
        </span>
        <span className="text-[10px] text-gray-500">
          {tr('高亮显示来自仪表盘的人工操作和人机交接步骤。', 'Highlights human actions and handoff steps from dashboard.')}
        </span>
      </div>
      <div className="rounded-xl border border-gray-200 bg-gray-50">
        <div
          ref={activityViewportRef}
          className="space-y-1 min-w-0 overflow-y-auto p-2"
          style={{ maxHeight: `${ACTIVITY_VISIBLE_MESSAGE_ROWS * ACTIVITY_ROW_EST_PX}px` }}
        >
          {topLevelItems.length === 0 ? (
            <p className="text-sm text-gray-400 py-2 px-3">{tr('暂无活动', 'No activity')}</p>
          ) : (
            topLevelItems.map((item) =>
              item.kind === 'task'
                ? renderTaskNode(item, 0)
                : renderMessageNode(item)
            )
          )}
        </div>
        {showExecutionLoader && (
          <div className="border-t border-gray-200 px-2 pb-2 pt-1.5">
            <div className={`task-exec-loader ${loaderToneClass}`}>
              <div className="relative z-[1] flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="task-exec-bars" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="text-xs font-semibold text-primary-700 truncate">
                    {runningHint}
                  </span>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${runningChipTone}`}>
                    {runningLabel}
                  </span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border border-gray-200 bg-gray-50 text-gray-600">
                    {tr('等待', 'Waiting')} {waitingElapsedText}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <p className="mt-2 text-[10px] text-gray-500">
        {tr('当前仅显示最近活动窗口（约 10 条消息），向上滚动可查看更早历史。', 'Currently showing only the latest activity window (about 10 messages); scroll up for earlier history.')}
      </p>

      {typeof document !== 'undefined' && createPortal(
        <div
          className={`fixed z-40 w-[22rem] max-w-[calc(100vw-2rem)] origin-left transition-[opacity,transform] duration-200 ease-out ${
            selectedMsg
              ? 'opacity-100 scale-x-100 translate-x-0 pointer-events-auto'
              : 'opacity-0 scale-x-95 -translate-x-2 pointer-events-none'
          } ${panelLayout.mobile ? 'top-24 bottom-6 right-4 md:right-6' : ''}`}
          style={panelLayout.mobile ? undefined : {
            top: `${panelLayout.top}px`,
            left: `${panelLayout.left}px`,
            height: `${panelLayout.height}px`,
          }}
        >
          {selectedMsg && (
            <MessageDetailPanel
              msg={selectedMsg}
              onClose={() => setSelectedMsgId(null)}
            />
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
