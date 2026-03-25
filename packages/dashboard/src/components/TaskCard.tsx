import { Task } from '@/lib/types';
import { StatusBadge } from './StatusBadge';
import { TaskFlow } from './BotAvatar';
import { formatDate } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

interface TaskCardProps {
  task: Task;
  onClick?: () => void;
}

const typeBadgeColors: Record<string, string> = {
  new: 'bg-blue-100 text-blue-800',
  'sub-task': 'bg-purple-100 text-purple-800',
};

const typeLabels: Record<string, string> = {
  new: '新任务',
  'sub-task': '子任务',
};

export function TaskCard({ task, onClick }: TaskCardProps) {
  const { tr, locale, term } = useI18n();
  const taskType = task.type || 'new';
  const taskTypeLabel = locale === 'zh'
    ? (typeLabels[taskType] || taskType)
    : (taskType === 'new' ? 'New Task' : taskType === 'sub-task' ? 'Sub-task' : taskType);
  const title = task.title || task.prompt || task.capability || term('task');
  const shortId = task.id.slice(0, 8);
  const fromName = task.fromBotName || task.fromBotId.slice(0, 8);
  const toName = task.toBotName || task.toBotId.slice(0, 8);
  const summary = task.prompt && task.prompt !== task.title ? task.prompt : '';
  const updatedAt = task.completedAt || task.startedAt || task.createdAt;

  return (
    <div
      onClick={onClick}
      className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-5 card-hover card-gradient cursor-pointer hover:border-primary-600/25 transition-colors"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 sm:gap-2 mb-2 flex-wrap">
            <StatusBadge status={task.status} className="shadow-sm" />
            <StatusBadge status={task.priority} className="opacity-80" />
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${typeBadgeColors[taskType] || 'bg-gray-100 text-gray-800'}`}
            >
              {taskTypeLabel}
            </span>
          </div>
          <h3 className="text-[15px] sm:text-base font-semibold text-gray-900 leading-snug break-words">{title}</h3>
          {summary && (
            <p className="mt-1 text-sm text-gray-600 text-clamp-2">
              {summary.length > 120 ? `${summary.slice(0, 120)}...` : summary}
            </p>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200/70 bg-gray-50 px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <TaskFlow
            fromName={task.fromBotName || task.fromBotId}
            fromId={task.fromBotId}
            fromAvatarColor={task.fromAvatarColor}
            fromAvatarUrl={task.fromAvatarUrl}
            toName={task.toBotName || task.toBotId}
            toId={task.toBotId}
            toAvatarColor={task.toAvatarColor}
            toAvatarUrl={task.toAvatarUrl}
            size="md"
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-gray-900 truncate">
              {fromName} → {toName}
            </div>
            <div className="text-[11px] text-gray-500 font-mono">{shortId}...</div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5 sm:gap-2 text-xs">
        {task.parentTaskId && (
          <span className="inline-flex items-center rounded-full bg-purple-50 px-2 py-1 text-purple-700">
            {tr('父任务', 'Parent')}: {task.parentTaskId.slice(0, 8)}...
          </span>
        )}
        {task.result !== undefined && task.result !== null && (
          <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-1 text-green-700">
            {tr('有结果', 'Has Result')}
          </span>
        )}
        {task.error && (
          <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-1 text-red-700">
            {tr('有错误', 'Has Error')}
          </span>
        )}
        {task.capability && task.capability !== 'general' && (
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-1 text-gray-600">
            {task.capability}
          </span>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-gray-200 flex items-center justify-between gap-2 text-[11px] sm:text-xs text-gray-500">
        <span>{tr('创建', 'Created')}: {formatDate(task.createdAt)}</span>
        <span className="text-right">{tr('更新', 'Updated')}: {formatDate(updatedAt)}</span>
      </div>
    </div>
  );
}
