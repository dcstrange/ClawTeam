import { Link } from 'react-router-dom';
import { useBots } from '@/hooks/useBots';
import { useTasks } from '@/hooks/useTasks';
import { BotAvatar } from '@/components/BotAvatar';
import { StatusBadge } from '@/components/StatusBadge';
import { formatDate } from '@/lib/utils';
import type { TaskStatus } from '@/lib/types';

interface BotSidebarProps {
  botId: string;
  onClose: () => void;
}

const ACTIVE_STATUSES: Set<TaskStatus> = new Set([
  'pending', 'accepted', 'processing', 'waiting_for_input',
]);

export function BotSidebar({ botId, onClose }: BotSidebarProps) {
  const { data: bots = [] } = useBots();
  const { data: tasks = [] } = useTasks();

  const bot = bots.find((b) => b.id === botId);
  if (!bot) return null;

  const activeTasks = tasks.filter(
    (t) => ACTIVE_STATUSES.has(t.status) && (t.fromBotId === botId || t.toBotId === botId),
  );

  return (
    <div className="w-[360px] shrink-0 border-l border-gray-200 glass-surface rounded-r-xl overflow-y-auto transition-all duration-200">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
        <BotAvatar name={bot.name} id={bot.id} avatarColor={bot.avatarColor} avatarUrl={bot.avatarUrl} size="lg" status={bot.status} />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 truncate">{bot.name}</h3>
          <StatusBadge status={bot.status} className="mt-0.5" />
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 transition-colors p-1"
          aria-label="Close sidebar"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Info */}
      <div className="px-5 py-4 space-y-2 text-sm border-b border-gray-100">
        <div className="flex justify-between">
          <span className="text-gray-500">ID</span>
          <span className="font-mono text-xs text-gray-700 truncate ml-2 max-w-[200px]">{bot.id}</span>
        </div>
        {bot.ownerEmail && (
          <div className="flex justify-between">
            <span className="text-gray-500">Owner</span>
            <span className="text-gray-700 truncate ml-2 max-w-[200px]">{bot.ownerEmail}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-gray-500">Registered</span>
          <span className="text-gray-700">{formatDate(bot.createdAt)}</span>
        </div>
        {bot.lastSeen && (
          <div className="flex justify-between">
            <span className="text-gray-500">Last seen</span>
            <span className="text-gray-700">{formatDate(bot.lastSeen)}</span>
          </div>
        )}
      </div>

      {/* Active Tasks */}
      <div className="px-5 py-4 border-b border-gray-100">
        <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
          Active Tasks ({activeTasks.length})
        </h4>
        {activeTasks.length === 0 ? (
          <p className="text-xs text-gray-400 italic">No active tasks</p>
        ) : (
          <div className="space-y-2">
            {activeTasks.map((task) => {
              const isFrom = task.fromBotId === botId;
              const peerName = isFrom
                ? (task.toBotName || task.toBotId)
                : (task.fromBotName || task.fromBotId);
              return (
                <Link
                  key={task.id}
                  to={`/tasks/${task.id}`}
                  className="block p-2 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-gray-800 truncate">
                      {task.capability || task.title || 'Task'}
                    </span>
                    <StatusBadge status={task.status} />
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {isFrom ? '→' : '←'} {peerName}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* Tags */}
      {bot.tags && bot.tags.length > 0 && (
        <div className="px-5 py-4 border-b border-gray-100">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Tags</h4>
          <div className="flex flex-wrap gap-1.5">
            {bot.tags.map((tag) => (
              <span key={tag} className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs">
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Capabilities */}
      {bot.capabilities.length > 0 && (
        <div className="px-5 py-4 border-b border-gray-100">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            Capabilities ({bot.capabilities.length})
          </h4>
          <div className="space-y-2">
            {bot.capabilities.map((cap) => (
              <div key={cap.name} className="text-sm">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-gray-800">{cap.name}</span>
                  {cap.async && (
                    <span className="px-1.5 py-0 bg-blue-50 text-blue-600 rounded text-[10px] font-medium">async</span>
                  )}
                  {cap.estimatedTime && (
                    <span className="px-1.5 py-0 bg-gray-50 text-gray-500 rounded text-[10px]">{cap.estimatedTime}</span>
                  )}
                </div>
                {cap.description && (
                  <p className="text-xs text-gray-500 mt-0.5">{cap.description}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="px-5 py-4">
        <Link
          to={`/bots/${bot.id}`}
          className="text-sm text-primary-600 hover:text-primary-700 font-medium"
        >
          View details →
        </Link>
      </div>
    </div>
  );
}
