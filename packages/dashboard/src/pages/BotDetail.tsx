import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useBots } from '@/hooks/useBots';
import { useTasks } from '@/hooks/useTasks';
import { Task } from '@/lib/types';
import { BotAvatar } from '@/components/BotAvatar';
import { StatusBadge } from '@/components/StatusBadge';
import { TaskFlow } from '@/components/BotAvatar';
import { TaskActions } from '@/components/TaskActions';
import { formatDate, formatDuration } from '@/lib/utils';
import { useI18n, trGlobal as trG, termGlobal as termG } from '@/lib/i18n';

export function BotDetail() {
  const { tr, term } = useI18n();
  const { botId } = useParams<{ botId: string }>();
  const navigate = useNavigate();
  const { data: bots = [], isLoading: botsLoading } = useBots();
  const { data: tasks = [], isLoading: tasksLoading } = useTasks();

  const bot = bots.find(b => b.id === botId);

  // Bot lookup for avatar enrichment
  const botMap = useMemo(() => {
    const map = new Map<string, { name: string; avatarColor?: string; avatarUrl?: string }>();
    for (const b of bots) {
      map.set(b.id, { name: b.name, avatarColor: b.avatarColor, avatarUrl: b.avatarUrl });
    }
    return map;
  }, [bots]);

  // Tasks related to this bot (as sender or receiver)
  const relatedTasks = useMemo(() => {
    if (!botId) return { sent: [], received: [] };
    const sent = tasks
      .filter(t => t.fromBotId === botId)
      .map(t => {
        const toBot = botMap.get(t.toBotId);
        const fromBot = botMap.get(t.fromBotId);
        return {
          ...t,
          fromBotName: t.fromBotName || fromBot?.name,
          fromAvatarColor: fromBot?.avatarColor,
          fromAvatarUrl: fromBot?.avatarUrl,
          toBotName: t.toBotName || toBot?.name,
          toAvatarColor: toBot?.avatarColor,
          toAvatarUrl: toBot?.avatarUrl,
        };
      });
    const received = tasks
      .filter(t => t.toBotId === botId)
      .map(t => {
        const toBot = botMap.get(t.toBotId);
        const fromBot = botMap.get(t.fromBotId);
        return {
          ...t,
          fromBotName: t.fromBotName || fromBot?.name,
          fromAvatarColor: fromBot?.avatarColor,
          fromAvatarUrl: fromBot?.avatarUrl,
          toBotName: t.toBotName || toBot?.name,
          toAvatarColor: toBot?.avatarColor,
          toAvatarUrl: toBot?.avatarUrl,
        };
      });
    return { sent, received };
  }, [botId, tasks, botMap]);

  if (botsLoading || tasksLoading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="h-48 bg-gray-200 rounded" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  if (!bot) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-yellow-50 rounded-xl p-6 text-center">
          <p className="text-yellow-800">{tr(`未找到${term('bot')}: ${botId}`, `${term('bot')} not found: ${botId}`)}</p>
          <button onClick={() => navigate('/bots')} className="mt-3 text-sm text-primary-600 hover:underline">
            {tr(`返回${term('bot')}列表`, `Back to ${term('bot')} list`)}
          </button>
        </div>
      </div>
    );
  }

  const totalTasks = relatedTasks.sent.length + relatedTasks.received.length;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <button onClick={() => navigate('/bots')} className="text-sm text-gray-500 hover:text-gray-700 mb-4 inline-block">
        &larr; {tr(`返回${term('bot')}列表`, `Back to ${term('bot')} list`)}
      </button>

      {/* Bot info card */}
      <div className="bg-white rounded-xl p-6 mb-6 card-gradient">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <BotAvatar name={bot.name} id={bot.id} avatarColor={bot.avatarColor} avatarUrl={bot.avatarUrl} size="lg" />
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-2xl font-bold text-gray-900">{bot.name}</h2>
                <StatusBadge status={bot.status} />
              </div>
              <p className="text-sm text-gray-500 font-mono mt-1">{bot.id}</p>
              {bot.ownerEmail && <p className="text-sm text-gray-500 mt-0.5">{bot.ownerEmail}</p>}
            </div>
          </div>
          <div className="text-right text-xs text-gray-500 space-y-1">
            <p>{tr('注册时间', 'Registered')}: {formatDate(bot.createdAt)}</p>
            {bot.lastSeen && <p>{tr('最后在线', 'Last seen')}: {formatDate(bot.lastSeen)}</p>}
          </div>
        </div>

        {/* Tags */}
        {bot.tags && bot.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1">
            {bot.tags.map((tag, i) => (
              <span key={i} className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded">{tag}</span>
            ))}
          </div>
        )}
      </div>

      {/* Capabilities */}
      <div className="bg-white rounded-xl p-6 mb-6 card-gradient">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">
          {tr(`能力（${bot.capabilities.length}）`, `Capabilities (${bot.capabilities.length})`)}
        </h3>
        {bot.capabilities.length === 0 ? (
          <p className="text-sm text-gray-400 italic">{tr('未注册能力', 'No capabilities registered')}</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {bot.capabilities.map((cap, idx) => (
              <div key={idx} className="bg-gray-50 rounded-xl p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-900">{cap.name}</span>
                  <div className="flex gap-1">
                    {cap.async && (
                      <span className="text-xs text-gray-500 bg-gray-200 px-2 py-0.5 rounded">{tr('异步', 'Async')}</span>
                    )}
                    {cap.estimatedTime && (
                      <span className="text-xs text-gray-500 bg-gray-200 px-2 py-0.5 rounded">{cap.estimatedTime}</span>
                    )}
                  </div>
                </div>
                <p className="text-xs text-gray-600">{cap.description}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Related tasks (tree view) */}
      <div className="bg-white rounded-xl p-6 card-gradient">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">
          {tr(`相关任务（${totalTasks}）`, `Related ${term('task')}s (${totalTasks})`)}
        </h3>

        {totalTasks === 0 ? (
          <p className="text-sm text-gray-400 italic">{tr(`暂无涉及该${term('bot')}的${term('task')}`, `No ${term('task')}s related to this ${term('bot')}`)}</p>
        ) : (
          <div className="space-y-6">
            {/* Received tasks */}
            {relatedTasks.received.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">
                  {tr(`接收（${relatedTasks.received.length}）`, `Received (${relatedTasks.received.length})`)}
                </h4>
                <TaskTree tasks={relatedTasks.received} allTasks={tasks} botMap={botMap} navigate={navigate} />
              </div>
            )}

            {/* Sent tasks */}
            {relatedTasks.sent.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">
                  {tr(`发送（${relatedTasks.sent.length}）`, `Sent (${relatedTasks.sent.length})`)}
                </h4>
                <TaskTree tasks={relatedTasks.sent} allTasks={tasks} botMap={botMap} navigate={navigate} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Tree structures ── */

interface TaskNode {
  task: Task;
  children: TaskNode[];
}

function buildTaskTree(
  tasks: Task[],
  allTasks: Task[],
  botMap: Map<string, { name: string; avatarColor?: string; avatarUrl?: string }>,
): TaskNode[] {
  const taskIds = new Set(tasks.map(t => t.id));
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  // Also index all tasks so we can find parent tasks that may not be in this bot's list
  const allTaskMap = new Map(allTasks.map(t => [t.id, t]));

  // Build children map: parentId → child tasks (only children in our set)
  const childrenMap = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.parentTaskId) {
      const arr = childrenMap.get(t.parentTaskId) || [];
      arr.push(t);
      childrenMap.set(t.parentTaskId, arr);
    }
  }

  // Root tasks: no parentTaskId, or parent is not in our set
  const roots: Task[] = [];
  const childIds = new Set<string>();

  for (const t of tasks) {
    if (t.parentTaskId && taskIds.has(t.parentTaskId)) {
      childIds.add(t.id);
    }
  }

  for (const t of tasks) {
    if (!childIds.has(t.id)) {
      roots.push(t);
    }
  }

  // Sort roots by createdAt desc
  roots.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  function buildNode(task: Task, depth: number): TaskNode {
    if (depth > 10) return { task, children: [] };
    const children = (childrenMap.get(task.id) || [])
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map(c => buildNode(c, depth + 1));
    return { task, children };
  }

  return roots.map(r => buildNode(r, 0));
}

function TaskTree({
  tasks,
  allTasks,
  botMap,
  navigate,
}: {
  tasks: Task[];
  allTasks: Task[];
  botMap: Map<string, { name: string; avatarColor?: string; avatarUrl?: string }>;
  navigate: (path: string) => void;
}) {
  const tree = useMemo(() => buildTaskTree(tasks, allTasks, botMap), [tasks, allTasks, botMap]);

  return (
    <div className="space-y-0.5">
      {tree.map(node => (
        <TaskTreeNode key={node.task.id} node={node} depth={0} navigate={navigate} />
      ))}
    </div>
  );
}

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

function TaskTreeNode({
  node,
  depth,
  navigate,
}: {
  node: TaskNode;
  depth: number;
  navigate: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const { task, children } = node;
  const hasChildren = children.length > 0;

  const duration = task.startedAt && task.completedAt
    ? new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()
    : null;

  return (
    <div>
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-gray-100 cursor-pointer group"
        style={{ paddingLeft: `${12 + depth * 24}px` }}
      >
        {/* Expand toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); if (hasChildren) setExpanded(!expanded); }}
          className={`shrink-0 w-5 h-5 flex items-center justify-center rounded transition-colors ${
            hasChildren
              ? 'text-gray-400 hover:text-gray-700 hover:bg-gray-200'
              : 'text-transparent'
          }`}
        >
          {hasChildren && <ChevronIcon expanded={expanded} />}
        </button>

        {/* Task row content */}
        <div
          className="flex items-center gap-3 flex-1 min-w-0"
          onClick={() => navigate(`/tasks/${task.id}`)}
        >
          <code className="text-xs font-mono text-gray-400 w-16 shrink-0">{task.id.slice(0, 8)}</code>
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
          <span className="text-sm text-gray-900 truncate min-w-0 flex-1">{task.title || task.prompt || task.capability || termG('task')}</span>
          {hasChildren && (
            <span className="text-[10px] text-gray-400 shrink-0">({children.length})</span>
          )}
          <StatusBadge status={task.status} />
          <StatusBadge status={task.priority} />
          {task.type === 'sub-task' && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800 shrink-0">{trG('子任务', 'Sub-task')}</span>
          )}
          <span className="text-xs text-gray-400 w-28 text-right shrink-0">{formatDate(task.createdAt)}</span>
          {duration !== null && (
            <span className="text-xs text-gray-400 w-16 text-right shrink-0">{formatDuration(duration)}</span>
          )}
          <div className="shrink-0" onClick={e => e.stopPropagation()}>
            <TaskActions task={task} />
          </div>
        </div>
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <div className="relative" style={{ marginLeft: `${12 + depth * 24 + 10}px` }}>
          <div className="absolute left-0 top-0 bottom-0 w-px bg-gray-200" />
          <div className="pl-3">
            {children.map(child => (
              <TaskTreeNode key={child.task.id} node={child} depth={0} navigate={navigate} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
