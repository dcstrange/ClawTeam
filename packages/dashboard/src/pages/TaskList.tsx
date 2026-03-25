import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTasks } from '@/hooks/useTasks';
import { useBots } from '@/hooks/useBots';
import { TaskCard } from '@/components/TaskCard';
import { TaskKanban } from '@/components/TaskKanban';
import { TaskGrouped } from '@/components/TaskGrouped';
import { CreateTaskModal } from '@/components/CreateTaskModal';
import { TaskStatus } from '@/lib/types';
import { useI18n } from '@/lib/i18n';

export function TaskList() {
  const { tr, term } = useI18n();
  const statusFilters: { label: string; value: TaskStatus | 'all' }[] = [
    { label: tr('全部', 'All'), value: 'all' },
    { label: tr('待处理', 'Pending'), value: 'pending' },
    { label: tr('已接收', 'Accepted'), value: 'accepted' },
    { label: tr('处理中', 'Processing'), value: 'processing' },
    { label: tr('待输入', 'Waiting'), value: 'waiting_for_input' },
    { label: tr('已完成', 'Completed'), value: 'completed' },
    { label: tr('失败', 'Failed'), value: 'failed' },
    { label: tr('超时', 'Timeout'), value: 'timeout' },
    { label: tr('已取消', 'Cancelled'), value: 'cancelled' },
  ];
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');
  const [viewMode, setViewMode] = useState<'list' | 'kanban' | 'grouped'>('grouped');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const { data: tasks = [], isLoading, error, refetch } = useTasks();
  const { data: bots = [] } = useBots();
  const navigate = useNavigate();

  // Build bot id → bot info lookup map
  const botMap = useMemo(() => {
    const map = new Map<string, { name: string; avatarColor?: string; avatarUrl?: string }>();
    for (const bot of bots) {
      map.set(bot.id, { name: bot.name, avatarColor: bot.avatarColor, avatarUrl: bot.avatarUrl });
    }
    return map;
  }, [bots]);

  // Enrich tasks with bot names and avatar data
  const enrichedTasks = useMemo(
    () =>
      tasks.map((task) => {
        const fromBot = botMap.get(task.fromBotId);
        const toBot = botMap.get(task.toBotId);
        return {
          ...task,
          fromBotName: task.fromBotName || fromBot?.name,
          fromAvatarColor: task.fromAvatarColor || fromBot?.avatarColor,
          fromAvatarUrl: task.fromAvatarUrl || fromBot?.avatarUrl,
          toBotName: task.toBotName || toBot?.name,
          toAvatarColor: task.toAvatarColor || toBot?.avatarColor,
          toAvatarUrl: task.toAvatarUrl || toBot?.avatarUrl,
        };
      }),
    [tasks, botMap],
  );

  const filteredTasks =
    statusFilter === 'all' ? enrichedTasks : enrichedTasks.filter((task) => task.status === statusFilter);
  const currentStatusLabel = statusFilters.find((filter) => filter.value === statusFilter)?.label || statusFilter;

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-80 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-red-50 rounded-xl p-4">
          <h3 className="text-red-800 font-medium">{tr(`加载${term('task')}失败`, `Failed to load ${term('task')}s`)}</h3>
          <p className="text-red-600 text-sm mt-1">{(error as Error).message}</p>
          <button
            onClick={() => refetch()}
            className="mt-3 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 text-sm"
          >
            {tr('重试', 'Retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">{term('task')}</h2>
          <p className="text-gray-600 mt-1">
            {tr(`显示 ${filteredTasks.length} / ${tasks.length} 个任务`, `Showing ${filteredTasks.length} / ${tasks.length} ${term('task')}s`)}
          </p>
        </div>
        <div className="flex gap-2">
          <div className="flex bg-gray-100 rounded-lg p-0.5 mr-2">
            <button
              onClick={() => setViewMode('grouped')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${viewMode === 'grouped' ? 'bg-white shadow text-gray-900' : 'text-gray-600'}`}
            >
              {tr('分组', 'Grouped')}
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${viewMode === 'list' ? 'bg-white shadow text-gray-900' : 'text-gray-600'}`}
            >
              {tr('列表', 'List')}
            </button>
            <button
              onClick={() => setViewMode('kanban')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${viewMode === 'kanban' ? 'bg-white shadow text-gray-900' : 'text-gray-600'}`}
            >
              {tr('看板', 'Kanban')}
            </button>
          </div>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
          >
            {tr(`创建${term('task')}`, `Create ${term('task')}`)}
          </button>
          <button
            onClick={() => refetch()}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            {tr('刷新', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="mb-6 flex gap-2">
        {statusFilters.map((filter) => (
          <button
            key={filter.value}
            onClick={() => setStatusFilter(filter.value)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === filter.value
                ? 'bg-primary-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {filteredTasks.length === 0 ? (
        <div className="empty-state">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
          <p className="text-gray-500 text-lg font-medium">{tr(`未找到${term('task')}`, `No ${term('task')}s found`)}</p>
          <p className="text-gray-400 text-sm mt-1">
            {statusFilter !== 'all'
              ? tr(`没有「${currentStatusLabel}」状态的任务`, `No ${term('task')}s with status "${currentStatusLabel}"`)
              : tr('创建任务后会显示在这里', `${term('task')}s will appear here after creation`)}
          </p>
        </div>
      ) : viewMode === 'kanban' ? (
        <TaskKanban tasks={filteredTasks} />
      ) : viewMode === 'grouped' ? (
        <TaskGrouped tasks={filteredTasks} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filteredTasks.map((task) => (
            <TaskCard key={task.id} task={task} onClick={() => navigate(`/tasks/${task.id}`)} />
          ))}
        </div>
      )}

      <CreateTaskModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={() => refetch()}
      />
    </div>
  );
}
