import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { StatusBadge } from './StatusBadge';
import { TaskActions } from './TaskActions';
import { TaskFlow } from './BotAvatar';
import { formatDate, formatDuration } from '@/lib/utils';
import type { Task, TaskStatus } from '@/lib/types';
import { useI18n, trGlobal as trG, termGlobal as termG } from '@/lib/i18n';

interface TaskGroupedProps {
  tasks: Task[];
}

interface TaskGroup {
  parentTask: Task | null; // null for orphan group
  parentId: string;
  children: Task[];
}

const statusOrder: Record<string, number> = {
  processing: 0, accepted: 1, pending: 2, failed: 3, timeout: 4, cancelled: 5, completed: 6,
};

export function TaskGrouped({ tasks }: TaskGroupedProps) {
  const { tr } = useI18n();
  const navigate = useNavigate();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const { groups, standalone } = useMemo(() => {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const childrenOf = new Map<string, Task[]>();
    const standaloneList: Task[] = [];

    // Collect all parentTaskIds that have children
    const parentIds = new Set<string>();
    for (const t of tasks) {
      if (t.parentTaskId) parentIds.add(t.parentTaskId);
    }

    // Group tasks
    for (const t of tasks) {
      if (t.parentTaskId) {
        const list = childrenOf.get(t.parentTaskId) || [];
        list.push(t);
        childrenOf.set(t.parentTaskId, list);
      } else if (!parentIds.has(t.id)) {
        // No parent and not a parent of anything → standalone
        standaloneList.push(t);
      }
    }

    // Build groups
    const groupList: TaskGroup[] = [];
    const seen = new Set<string>();

    for (const [parentId, children] of childrenOf) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      // Sort children: active first, then by creation time
      children.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      groupList.push({
        parentTask: taskMap.get(parentId) || null,
        parentId,
        children,
      });
    }

    // Sort groups: groups with active children first
    groupList.sort((a, b) => {
      const aActive = a.children.some(c => ['pending', 'accepted', 'processing'].includes(c.status));
      const bActive = b.children.some(c => ['pending', 'accepted', 'processing'].includes(c.status));
      if (aActive !== bActive) return aActive ? -1 : 1;
      return new Date(b.children[0]?.createdAt || 0).getTime() - new Date(a.children[0]?.createdAt || 0).getTime();
    });

    return { groups: groupList, standalone: standaloneList };
  }, [tasks]);

  function toggleGroup(parentId: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }

  function statusSummary(children: Task[]) {
    const counts: Partial<Record<TaskStatus, number>> = {};
    for (const c of children) {
      counts[c.status] = (counts[c.status] || 0) + 1;
    }
    return counts;
  }

  return (
    <div className="space-y-3">
      {groups.map(group => {
        const isExpanded = expandedGroups.has(group.parentId);
        const summary = statusSummary(group.children);
        const parentCap = group.parentTask?.title || group.parentTask?.prompt || group.parentTask?.capability || tr('未知', 'Unknown');
        const hasActive = group.children.some(c => ['pending', 'accepted', 'processing'].includes(c.status));

        return (
          <div key={group.parentId} className={`bg-white rounded-xl card-gradient ${hasActive ? 'ring-1 ring-primary-200' : ''}`}>
            {/* Group header */}
            <div
              onClick={() => toggleGroup(group.parentId)}
              className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-100 select-none"
            >
              <span className={`text-gray-400 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.5 2.5L8 6L4.5 9.5" />
                </svg>
              </span>

              {group.parentTask ? (
                <>
                  <span className="font-medium text-gray-900">{parentCap}</span>
                  <StatusBadge status={group.parentTask.status} />
                  <code
                    className="text-xs font-mono text-primary-600 hover:text-primary-800 cursor-pointer"
                    onClick={(e) => { e.stopPropagation(); navigate(`/tasks/${group.parentId}`); }}
                  >
                    {group.parentId.slice(0, 8)}
                  </code>
                </>
              ) : (
                <>
                  <span className="font-medium text-gray-500 italic">{tr('外部父任务', 'External Parent Task')}</span>
                  <code className="text-xs font-mono text-gray-400">{group.parentId.slice(0, 8)}</code>
                </>
              )}

              <span className="text-sm text-gray-500 ml-auto mr-2">
                {tr(`${group.children.length} 个子任务`, `${group.children.length} sub-tasks`)}
              </span>

              {/* Status summary pills */}
              <div className="flex gap-1">
                {Object.entries(summary).map(([status, count]) => (
                  <span key={status} className="flex items-center gap-0.5">
                    <StatusBadge status={status} />
                    {count! > 1 && <span className="text-xs text-gray-500">×{count}</span>}
                  </span>
                ))}
              </div>
            </div>

            {/* Expanded children */}
            {isExpanded && (
              <div className="border-t border-gray-100 divide-y divide-gray-50">
                {group.children.map(child => (
                  <ChildRow key={child.id} task={child} onClick={() => navigate(`/tasks/${child.id}`)} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Standalone tasks */}
      {standalone.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-gray-500 mb-2">{tr(`独立任务（${standalone.length}）`, `Standalone Tasks (${standalone.length})`)}</h3>
          <div className="space-y-2">
            {standalone.map(task => (
              <ChildRow key={task.id} task={task} onClick={() => navigate(`/tasks/${task.id}`)} showCapability />
            ))}
          </div>
        </div>
      )}

      {groups.length === 0 && standalone.length === 0 && (
        <div className="empty-state">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
          <p className="text-gray-500 font-medium">{tr('未找到任务', 'No tasks found')}</p>
        </div>
      )}
    </div>
  );
}

function ChildRow({ task, onClick, showCapability }: { task: Task; onClick: () => void; showCapability?: boolean }) {
  const duration = task.startedAt && task.completedAt
    ? new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()
    : null;

  const rowStatusColors: Record<string, string> = {
    processing: 'hover:bg-purple-50',
    completed: 'hover:bg-green-50',
    failed: 'hover:bg-red-50',
    pending: 'hover:bg-blue-50',
    accepted: 'hover:bg-cyan-100',
    waiting_for_input: 'hover:bg-amber-50',
  };

  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-3 px-6 py-2.5 hover:bg-gray-50 cursor-pointer transition-colors ${rowStatusColors[task.status] || ''}`}
    >
      <code className="text-xs font-mono text-gray-500 w-16 shrink-0">{task.id.slice(0, 8)}</code>
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
      <span className="text-sm text-gray-900 truncate min-w-0 flex-1">
        {showCapability
          ? (task.title || task.prompt || task.capability || termG('task'))
          : (task.type === 'sub-task' ? trG('子任务', 'Sub-task') : trG('新任务', 'New Task'))}
      </span>
      <StatusBadge status={task.status} />
      <StatusBadge status={task.priority} />
      <span className="text-xs text-gray-400 w-28 text-right shrink-0">{formatDate(task.createdAt)}</span>
      {duration !== null && (
        <span className="text-xs text-gray-400 w-16 text-right shrink-0">{formatDuration(duration)}</span>
      )}
      <div className="shrink-0" onClick={e => e.stopPropagation()}>
        <TaskActions task={task} />
      </div>
    </div>
  );
}
