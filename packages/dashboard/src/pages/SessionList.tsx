import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSessions } from '@/hooks/useRouterStatus';
import { StatusBadge } from '@/components/StatusBadge';
import { formatDuration } from '@/lib/utils';
import type { SessionStatus } from '@/lib/types';
import { useI18n } from '@/lib/i18n';

export function SessionList() {
  const { tr, term } = useI18n();
  const { data: sessions = [], isLoading, error, refetch } = useSessions();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4" />
          <div className="space-y-3">
            {[1, 2, 3].map(i => <div key={i} className="h-16 bg-gray-200 rounded" />)}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-red-50 rounded-xl p-4">
          <h3 className="text-red-800 font-medium">{tr(`加载${term('session')}失败`, `Failed to load ${term('session')}s`)}</h3>
          <p className="text-red-600 text-sm mt-1">{(error as Error).message}</p>
          <button onClick={() => refetch()} className="mt-3 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 text-sm">
            {tr('重试', 'Retry')}
          </button>
        </div>
      </div>
    );
  }

  const stateGroups = sessions.reduce<Record<string, number>>((acc, s) => {
    acc[s.sessionState] = (acc[s.sessionState] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">{term('session')}</h2>
          <p className="text-gray-600 mt-1">{tr(`已追踪 ${sessions.length} 个会话`, `${sessions.length} ${term('session')}s tracked`)}</p>
        </div>
        <button onClick={() => refetch()} className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700">
          {tr('刷新', 'Refresh')}
        </button>
      </div>

      {/* State summary */}
      <div className="flex gap-3 mb-6 flex-wrap">
        {Object.entries(stateGroups).map(([state, count]) => (
          <div key={state} className="flex items-center gap-1.5">
            <StatusBadge status={state} />
            <span className="text-sm text-gray-600">{count}</span>
          </div>
        ))}
      </div>

      {/* Sessions table */}
      <div className="bg-white rounded-xl overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead>
            <tr className="bg-gray-50">
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{tr(`${term('session')}键`, `${term('session')} Key`)}</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{tr('状态', 'Status')}</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{tr('任务 ID', 'Task ID')}</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{tr('智能体', 'Agent')}</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{tr('存活时长', 'Uptime')}</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{tr('在线', 'Alive')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {sessions.length === 0 ? (
              <tr><td colSpan={6} className="px-6 py-12 text-center">
                <div className="text-gray-400">
                  <svg className="w-10 h-10 mx-auto mb-3 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>
                  <p className="text-sm font-medium">{tr(`暂无追踪${term('session')}`, `No tracked ${term('session')}s`)}</p>
                </div>
              </td></tr>
            ) : (
              sessions.map((session) => (
                <SessionRow
                  key={session.sessionKey}
                  session={session}
                  isExpanded={expandedKey === session.sessionKey}
                  onToggle={() => setExpandedKey(expandedKey === session.sessionKey ? null : session.sessionKey)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SessionRow({ session, isExpanded, onToggle }: { session: SessionStatus; isExpanded: boolean; onToggle: () => void }) {
  const { tr, term } = useI18n();
  const { details } = session;
  return (
    <>
      <tr onClick={onToggle} className="hover:bg-gray-100 cursor-pointer transition-colors">
        <td className="px-6 py-4 text-sm font-mono text-gray-900 max-w-[200px] truncate">{session.sessionKey}</td>
        <td className="px-6 py-4"><StatusBadge status={session.sessionState} /></td>
        <td className="px-6 py-4 text-sm font-mono text-primary-600 hover:text-primary-800">
          <Link to={`/tasks/${session.taskId}`}>{session.taskId.slice(0, 8)}...</Link>
        </td>
        <td className="px-6 py-4 text-sm text-gray-600">{details.agentId || '—'}</td>
        <td className="px-6 py-4 text-sm text-gray-600">{details.ageMs ? formatDuration(details.ageMs) : '—'}</td>
        <td className="px-6 py-4">
          <span className={`inline-block w-2 h-2 rounded-full ${details.alive ? 'bg-green-500' : 'bg-red-500'}`} />
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={6} className="px-6 py-4 bg-gray-50">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">{tr(`${term('session')} ID`, `${term('session')} ID`)}: </span>
                <code className="font-mono text-xs">{details.sessionId || tr('无', 'N/A')}</code>
              </div>
              <div>
                <span className="text-gray-500">{tr('最近活跃时间', 'Last active at')}: </span>
                <span>{session.lastActivityAt ? new Date(session.lastActivityAt).toLocaleString() : tr('无', 'N/A')}</span>
              </div>
              {details.jsonlAnalysis && (
                <>
                  <div>
                    <span className="text-gray-500">{tr('最后角色', 'Last role')}: </span>
                    <span>{details.jsonlAnalysis.lastMessageRole || tr('无', 'N/A')}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">{tr('停止原因', 'Stop reason')}: </span>
                    <span>{details.jsonlAnalysis.lastStopReason || tr('无', 'N/A')}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">{tr('工具调用数', 'Tool calls')}: </span>
                    <span>{details.jsonlAnalysis.toolCallCount}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">{tr('模型', 'Model')}: </span>
                    <span>{details.jsonlAnalysis.model || tr('无', 'N/A')}</span>
                  </div>
                  {details.jsonlAnalysis.lastErrorMessage && (
                    <div className="col-span-2">
                      <span className="text-red-500">{tr('错误', 'Error')}: </span>
                      <span className="text-red-700">{details.jsonlAnalysis.lastErrorMessage}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
