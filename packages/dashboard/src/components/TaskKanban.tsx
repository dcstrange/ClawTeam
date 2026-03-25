import { useNavigate } from 'react-router-dom';
import { StatusBadge } from '@/components/StatusBadge';
import { TaskActions } from '@/components/TaskActions';
import { TaskFlow } from '@/components/BotAvatar';
import type { Task } from '@/lib/types';
import { useI18n } from '@/lib/i18n';

interface TaskKanbanProps {
  tasks: Task[];
}

export function TaskKanban({ tasks }: TaskKanbanProps) {
  const { tr } = useI18n();
  const navigate = useNavigate();
  const columns: Array<{ label: string; statuses: Task['status'][]; dotColor: string; bgTint: string }> = [
    { label: tr('待处理', 'Pending'), statuses: ['pending', 'accepted'], dotColor: 'bg-blue-400', bgTint: 'kanban-tint-blue' },
    { label: tr('处理中', 'Processing'), statuses: ['processing'], dotColor: 'bg-purple-500', bgTint: 'kanban-tint-purple' },
    { label: tr('等待输入', 'Waiting'), statuses: ['waiting_for_input'], dotColor: 'bg-amber-500', bgTint: 'kanban-tint-amber' },
    { label: tr('待审核', 'Pending Review'), statuses: ['pending_review'], dotColor: 'bg-indigo-500', bgTint: 'kanban-tint-indigo' },
    { label: tr('已完成', 'Completed'), statuses: ['completed'], dotColor: 'bg-green-500', bgTint: 'kanban-tint-green' },
    { label: tr('失败', 'Failed'), statuses: ['failed', 'timeout', 'cancelled'], dotColor: 'bg-red-500', bgTint: 'kanban-tint-red' },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {columns.map((col) => {
        const colTasks = tasks.filter(t => col.statuses.includes(t.status));
        return (
          <div key={col.label} className={`rounded-xl p-3 ${col.bgTint}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${col.dotColor}`} />
                <h3 className="text-sm font-semibold text-gray-700">{col.label}</h3>
              </div>
              <span className="text-xs text-gray-500 bg-gray-200 px-2 py-0.5 rounded-full">{colTasks.length}</span>
            </div>
            <div className="space-y-2 max-h-[calc(100vh-280px)] overflow-y-auto">
              {colTasks.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-4">{tr('暂无任务', 'No tasks')}</p>
              ) : (
                colTasks.map(task => (
                  <div
                    key={task.id}
                    onClick={() => navigate(`/tasks/${task.id}`)}
                    className="bg-white rounded-xl p-3 hover:shadow-md transition-shadow cursor-pointer"
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-sm font-medium text-gray-900 truncate">{task.capability}</span>
                      <StatusBadge status={task.priority} />
                    </div>
                    <p className="text-xs text-gray-500 mb-1 font-mono">{task.id.slice(0, 8)}...</p>
                    <div className="flex items-center gap-2">
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
                    </div>
                    <div className="mt-2">
                      <TaskActions task={task} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
