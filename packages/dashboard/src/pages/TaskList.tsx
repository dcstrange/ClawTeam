import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTasks } from '@/hooks/useTasks';
import { useBots } from '@/hooks/useBots';
import { TaskCard } from '@/components/TaskCard';
import { TaskKanban } from '@/components/TaskKanban';
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
  const [viewMode, setViewMode] = useState<'list' | 'kanban'>('kanban');
  const [search, setSearch] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
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

  const statusCounts = useMemo(() => {
    const counts = new Map<TaskStatus | 'all', number>();
    counts.set('all', enrichedTasks.length);
    for (const filter of statusFilters) {
      if (filter.value !== 'all') counts.set(filter.value, 0);
    }
    for (const task of enrichedTasks) {
      counts.set(task.status, (counts.get(task.status) || 0) + 1);
    }
    return counts;
  }, [enrichedTasks]);

  const filteredTasks = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return enrichedTasks.filter((task) => {
      const statusPass = statusFilter === 'all' || task.status === statusFilter;
      if (!statusPass) return false;
      if (!normalizedSearch) return true;
      const text = [
        task.id,
        task.title || '',
        task.prompt || '',
        task.capability || '',
        task.fromBotName || '',
        task.toBotName || '',
        task.fromBotId,
        task.toBotId,
      ]
        .join(' ')
        .toLowerCase();
      return text.includes(normalizedSearch);
    });
  }, [enrichedTasks, statusFilter, search]);

  const quickStats = useMemo(() => {
    const active = enrichedTasks.filter((task) =>
      ['pending', 'accepted', 'processing', 'waiting_for_input', 'pending_review'].includes(task.status),
    ).length;
    const done = enrichedTasks.filter((task) => task.status === 'completed').length;
    const problematic = enrichedTasks.filter((task) =>
      ['failed', 'timeout', 'cancelled'].includes(task.status),
    ).length;
    return { active, done, problematic };
  }, [enrichedTasks]);

  const currentStatusLabel = statusFilters.find((filter) => filter.value === statusFilter)?.label || statusFilter;
  const statusFilterStyles: Record<TaskStatus | 'all', { active: string; idle: string; dot: string }> = {
    all: { active: 'bg-primary-600 text-white', idle: 'bg-gray-100 text-gray-700 hover:bg-gray-200', dot: 'bg-gray-400' },
    pending: { active: 'bg-blue-600 text-white', idle: 'bg-blue-50 text-blue-800 hover:bg-blue-100', dot: 'bg-blue-500' },
    accepted: { active: 'bg-cyan-600 text-white', idle: 'bg-cyan-50 text-cyan-800 hover:bg-cyan-100', dot: 'bg-cyan-500' },
    processing: { active: 'bg-purple-600 text-white', idle: 'bg-purple-50 text-purple-800 hover:bg-purple-100', dot: 'bg-purple-500' },
    waiting_for_input: { active: 'bg-amber-700 text-white', idle: 'bg-amber-50 text-amber-800 hover:bg-amber-100', dot: 'bg-amber-500' },
    completed: { active: 'bg-green-700 text-white', idle: 'bg-green-50 text-green-800 hover:bg-green-100', dot: 'bg-green-500' },
    failed: { active: 'bg-red-700 text-white', idle: 'bg-red-50 text-red-800 hover:bg-red-100', dot: 'bg-red-500' },
    timeout: { active: 'bg-orange-700 text-white', idle: 'bg-orange-100 text-orange-800 hover:bg-orange-100', dot: 'bg-orange-500' },
    cancelled: { active: 'bg-gray-700 text-white', idle: 'bg-gray-100 text-gray-700 hover:bg-gray-200', dot: 'bg-gray-500' },
    pending_review: { active: 'bg-indigo-700 text-white', idle: 'bg-indigo-50 text-indigo-800 hover:bg-indigo-100', dot: 'bg-indigo-500' },
  };

  if (isLoading) {
    return (
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse">
          <div className="h-10 bg-gray-200 rounded-xl w-80 mb-6"></div>
          <div className="grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)] gap-6">
            <div className="h-[520px] bg-gray-200 rounded-2xl"></div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-44 bg-gray-200 rounded-2xl"></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
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
    <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">{term('task')}</h2>
          <p className="text-gray-600 mt-1">
            {tr(`显示 ${filteredTasks.length} / ${tasks.length} 个任务`, `Showing ${filteredTasks.length} / ${tasks.length} ${term('task')}s`)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setFiltersOpen((open) => !open)}
            className="xl:hidden px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm hover:bg-gray-200 transition-colors"
          >
            {filtersOpen ? tr('收起筛选', 'Hide Filters') : tr('展开筛选', 'Show Filters')}
          </button>
          <div className="flex bg-gray-100 rounded-xl p-0.5">
            <button
              onClick={() => setViewMode('kanban')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                viewMode === 'kanban' ? 'bg-white shadow text-gray-900' : 'text-gray-600'
              }`}
            >
              {tr('看板', 'Board')}
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                viewMode === 'list' ? 'bg-white shadow text-gray-900' : 'text-gray-600'
              }`}
            >
              {tr('列表', 'List')}
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

      <div className="xl:hidden grid grid-cols-3 gap-2 mb-4">
        <div className="rounded-xl bg-gray-100 px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-gray-500">{tr('活跃', 'Active')}</p>
          <p className="text-base font-semibold text-gray-900">{quickStats.active}</p>
        </div>
        <div className="rounded-xl bg-gray-100 px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-gray-500">{tr('已完成', 'Done')}</p>
          <p className="text-base font-semibold text-gray-900">{quickStats.done}</p>
        </div>
        <div className="rounded-xl bg-gray-100 px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-gray-500">{tr('异常', 'Issues')}</p>
          <p className="text-base font-semibold text-gray-900">{quickStats.problematic}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)] gap-6">
        <aside className={`bg-white rounded-2xl border border-gray-200 card-gradient p-4 h-fit ${filtersOpen ? 'block' : 'hidden'} xl:block xl:sticky xl:top-20`}>
          <div className="space-y-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">{tr('筛选', 'Filters')}</p>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={tr('搜索任务 / Bot / ID', 'Search task / bot / ID')}
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-600/30"
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-1 gap-1.5">
              {statusFilters.map((filter) => {
                const active = statusFilter === filter.value;
                const count = statusCounts.get(filter.value) || 0;
                const styleSet = statusFilterStyles[filter.value];
                return (
                  <button
                    key={filter.value}
                    onClick={() => setStatusFilter(filter.value)}
                    className={`w-full flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
                      active ? styleSet.active : styleSet.idle
                    }`}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${styleSet.dot}`} />
                      {filter.label}
                    </span>
                    <span className={`text-xs rounded-full px-2 py-0.5 ${active ? 'bg-white/20 text-white' : 'bg-gray-200 text-gray-600'}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="pt-2 border-t border-gray-200 space-y-2">
              <div className="rounded-lg bg-gray-100 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-gray-500">{tr('活跃', 'Active')}</p>
                <p className="text-lg font-semibold text-gray-900">{quickStats.active}</p>
              </div>
              <div className="rounded-lg bg-gray-100 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-gray-500">{tr('已完成', 'Completed')}</p>
                <p className="text-lg font-semibold text-gray-900">{quickStats.done}</p>
              </div>
              <div className="rounded-lg bg-gray-100 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-gray-500">{tr('异常', 'Issues')}</p>
                <p className="text-lg font-semibold text-gray-900">{quickStats.problematic}</p>
              </div>
            </div>
          </div>
        </aside>

        <section>
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
          ) : (
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3 sm:gap-4">
              {filteredTasks.map((task) => (
                <TaskCard key={task.id} task={task} onClick={() => navigate(`/tasks/${task.id}`)} />
              ))}
            </div>
          )}
        </section>
      </div>

      <CreateTaskModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={() => refetch()}
      />
    </div>
  );
}
