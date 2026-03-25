import { useBots } from '@/hooks/useBots';
import { useTasks } from '@/hooks/useTasks';
import { useRouterStatus, useSessions } from '@/hooks/useRouterStatus';
import { StatusBadge } from '@/components/StatusBadge';
import { BotAvatar } from '@/components/BotAvatar';
import { formatDuration } from '@/lib/utils';
import { routerApi } from '@/lib/router-api';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { TeamWorkspace } from '@/components/workspace/TeamWorkspace';
import { useI18n } from '@/lib/i18n';

export function Dashboard() {
  const { tr, term } = useI18n();
  const { data: bots = [] } = useBots();
  const { data: tasks = [] } = useTasks();
  const { data: routerStatus } = useRouterStatus();
  const { data: sessions = [] } = useSessions();
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [resetMsgOk, setResetMsgOk] = useState<boolean | null>(null);

  const handleResetMainSession = async () => {
    if (!confirm(tr('重置主会话？这会归档当前记录并重新开始。', 'Reset main session? This will archive current transcript and start fresh.'))) return;
    setResetting(true);
    setResetMsg(null);
    setResetMsgOk(null);
    try {
      const res = await routerApi.resetMainSession();
      setResetMsgOk(!!res.success);
      setResetMsg(
        res.success
          ? tr(`重置成功，新会话：${res.newSessionId}`, `Reset succeeded, new session: ${res.newSessionId}`)
          : tr(`失败：${res.message}`, `Failed: ${res.message}`),
      );
    } catch (e) {
      setResetMsgOk(false);
      setResetMsg(tr(`错误：${(e as Error).message}`, `Error: ${(e as Error).message}`));
    } finally {
      setResetting(false);
    }
  };

  const botsOnline = bots.filter((bot) => bot.status === 'online').length;
  const tasksCompleted = tasks.filter((task) => task.status === 'completed').length;
  const tasksPending = tasks.filter((task) => task.status === 'pending').length;
  const tasksProcessing = tasks.filter((task) => task.status === 'processing').length;

  const stats = [
    { label: tr(`${term('bot')}总数`, 'Total Bots'), value: bots.length, subtext: tr(`${botsOnline} 在线`, `${botsOnline} online`) },
    { label: tr(`${term('task')}总数`, 'Total Tasks'), value: tasks.length, subtext: tr('累计', 'all time') },
    { label: tr('已完成', 'Completed'), value: tasksCompleted, subtext: tr('任务', 'tasks') },
    { label: tr('处理中', 'Processing'), value: tasksProcessing, subtext: tr('任务', 'tasks') },
    { label: tr('待处理', 'Pending'), value: tasksPending, subtext: tr('任务', 'tasks') },
  ];

  const recentTasks = tasks.slice(-5).reverse();

  // Session state summary
  const sessionStateGroups = sessions.reduce<Record<string, number>>((acc, s) => {
    acc[s.sessionState] = (acc[s.sessionState] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 glass-intensity-soft">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">{tr('仪表盘', 'Dashboard')}</h2>
          <p className="text-gray-600 mt-1">{tr('ClawTeam 平台总览', 'Overview of your ClawTeam platform')}</p>
        </div>
        <div className="flex items-center gap-3">
          {resetMsg && (
            <span className={`text-xs ${resetMsgOk ? 'text-green-600' : 'text-red-600'}`}>
              {resetMsg}
            </span>
          )}
          <button
            onClick={handleResetMainSession}
            disabled={resetting}
            className="px-3 py-1.5 text-sm font-medium rounded text-red-700 bg-red-50 hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {resetting ? tr('重置中...', 'Resetting...') : tr('重置主会话', 'Reset Main Session')}
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-6 mb-8">
        {stats.map((stat, i) => (
          <div
            key={stat.label}
            className={`bg-white rounded-xl p-6 card-hover animate-stagger stat-gradient-${i}`}
            style={{ '--stagger-index': i } as React.CSSProperties}
          >
            <p className="text-sm font-medium text-gray-600">{stat.label}</p>
            <p className="text-3xl font-bold text-gray-900 mt-2" style={{ fontVariantNumeric: 'tabular-nums' }}>{stat.value}</p>
            <p className="text-xs text-gray-500 mt-1">{stat.subtext}</p>
          </div>
        ))}
      </div>

      {/* Team Workspace */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">{tr('团队工作区', 'Team Workspace')}</h3>
          <Link to="/team" className="text-sm text-primary-600 hover:text-primary-700 font-medium group inline-flex items-center gap-1">{tr('查看完整视图', 'View full')} <span className="transition-transform group-hover:translate-x-0.5">&rarr;</span></Link>
        </div>
        <div className="bg-white rounded-xl p-4 card-gradient">
          <TeamWorkspace compact />
        </div>
      </div>

      {/* Router Status + Session Overview */}
      {routerStatus && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <div className="bg-white rounded-xl p-6 animate-fade-in card-gradient">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">{tr(`${term('route')}状态`, 'Router Status')}</h3>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                {tr('运行中', 'running')}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-500">{tr('运行时长', 'Uptime')}</p>
                <p className="font-medium text-gray-900">{formatDuration(routerStatus.uptime)}</p>
              </div>
              <div>
                <p className="text-gray-500">{tr('追踪任务数', 'Tracked Tasks')}</p>
                <p className="font-medium text-gray-900">{routerStatus.trackedTasks}</p>
              </div>
              <div>
                <p className="text-gray-500">{tr(`活跃${term('session')}`, 'Active Sessions')}</p>
                <p className="font-medium text-gray-900">{routerStatus.activeSessions}</p>
              </div>
              <div>
                <p className="text-gray-500">{tr('轮询间隔', 'Poll Interval')}</p>
                <p className="font-medium text-gray-900">{formatDuration(routerStatus.pollIntervalMs)}</p>
              </div>
              <div>
                <p className="text-gray-500">{tr('心跳', 'Heartbeat')}</p>
                <p className="font-medium text-gray-900">{routerStatus.heartbeatRunning ? tr('已启用', 'Active') : tr('已禁用', 'Disabled')}</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">{tr(`${term('session')}概览`, 'Session Overview')}</h3>
              <Link to="/sessions" className="text-sm text-primary-600 hover:text-primary-700 font-medium group inline-flex items-center gap-1">{tr('查看全部', 'View all')} <span className="transition-transform group-hover:translate-x-0.5">&rarr;</span></Link>
            </div>
            {sessions.length === 0 ? (
              <p className="text-gray-400 text-sm italic">{tr('暂无追踪会话', 'No sessions tracked')}</p>
            ) : (
              <div className="space-y-3">
                {Object.entries(sessionStateGroups).map(([state, count]) => (
                  <div key={state} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                    <StatusBadge status={state} />
                    <span className="text-lg font-semibold text-gray-900">{count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Bots Section */}
        <div className="bg-white rounded-xl p-6 card-gradient">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">{tr(`活跃${term('bot')}`, 'Active Bots')}</h3>
            <Link
              to="/bots"
              className="text-sm text-primary-600 hover:text-primary-700 font-medium group inline-flex items-center gap-1"
            >
              {tr('查看全部', 'View all')} <span className="transition-transform group-hover:translate-x-0.5">&rarr;</span>
            </Link>
          </div>
          <div className="space-y-3">
            {bots.length === 0 ? (
              <p className="text-gray-400 text-sm italic">{tr('暂无已注册机器人', 'No bots registered')}</p>
            ) : (
              bots.slice(0, 5).map((bot, i) => (
                <div
                  key={bot.id}
                  className="flex items-center justify-between p-3 bg-gray-50 rounded animate-stagger"
                  style={{ '--stagger-index': i } as React.CSSProperties}
                >
                  <div className="flex items-center gap-3">
                    <BotAvatar
                      name={bot.name}
                      id={bot.id}
                      avatarColor={bot.avatarColor}
                      avatarUrl={bot.avatarUrl}
                      size="sm"
                      status={bot.status}
                    />
                    <div>
                      <p className="font-medium text-gray-900">{bot.name}</p>
                      <p className="text-xs text-gray-500">
                        {tr(`${bot.capabilities.length} 个能力`, `${bot.capabilities.length} capabilities`)}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={bot.status} />
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Tasks Section */}
        <div className="bg-white rounded-xl p-6 card-gradient">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">{tr('最近任务', 'Recent Tasks')}</h3>
            <Link
              to="/tasks"
              className="text-sm text-primary-600 hover:text-primary-700 font-medium group inline-flex items-center gap-1"
            >
              {tr('查看全部', 'View all')} <span className="transition-transform group-hover:translate-x-0.5">&rarr;</span>
            </Link>
          </div>
          <div className="space-y-3">
            {recentTasks.length === 0 ? (
              <p className="text-gray-400 text-sm italic">{tr('暂无任务', 'No tasks yet')}</p>
            ) : (
              recentTasks.map((task, i) => (
                <Link
                  key={task.id}
                  to={`/tasks/${task.id}`}
                  className="flex items-center justify-between p-3 bg-gray-50 rounded animate-stagger hover:bg-gray-100 transition-colors"
                  style={{ '--stagger-index': i } as React.CSSProperties}
                >
                  <div>
                    <p className="font-medium text-gray-900">{task.capability}</p>
                    <p className="text-xs text-gray-500">
                      {task.fromBotName || task.fromBotId} → {task.toBotName || task.toBotId}
                    </p>
                  </div>
                  <StatusBadge status={task.status} />
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
