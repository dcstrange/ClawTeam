import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useRouteHistory } from '@/hooks/useRouterStatus';
import { StatusBadge } from '@/components/StatusBadge';
import type { RouteHistoryEntry } from '@/lib/types';
import { useI18n } from '@/lib/i18n';

type FilterAction = 'all' | 'send_to_main' | 'send_to_session';
type FilterSuccess = 'all' | 'success' | 'failed';

export function RouteHistory() {
  const { tr, term } = useI18n();
  const { data: entries = [], isLoading, error, refetch } = useRouteHistory();
  const [actionFilter, setActionFilter] = useState<FilterAction>('all');
  const [successFilter, setSuccessFilter] = useState<FilterSuccess>('all');

  const filtered = entries.filter((e) => {
    if (actionFilter !== 'all' && e.action !== actionFilter) return false;
    if (successFilter === 'success' && !e.success) return false;
    if (successFilter === 'failed' && e.success) return false;
    return true;
  });

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4" />
          <div className="space-y-3">
            {[1, 2, 3].map(i => <div key={i} className="h-12 bg-gray-200 rounded" />)}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-red-50 rounded-xl p-4">
          <h3 className="text-red-800 font-medium">{tr(`加载${term('route')}历史失败`, `Failed to load ${term('route')} history`)}</h3>
          <p className="text-red-600 text-sm mt-1">{(error as Error).message}</p>
          <button onClick={() => refetch()} className="mt-3 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 text-sm">
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
          <h2 className="text-2xl font-bold text-gray-900">{tr(`${term('route')}历史`, `${term('route')} History`)}</h2>
          <p className="text-gray-600 mt-1">{tr(`显示 ${filtered.length} / ${entries.length} 条记录`, `Showing ${filtered.length} / ${entries.length} records`)}</p>
        </div>
        <button onClick={() => refetch()} className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700">
          {tr('刷新', 'Refresh')}
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        <div className="flex gap-2 items-center">
          <span className="text-sm text-gray-600">{tr('动作', 'Action')}:</span>
          {(['all', 'send_to_main', 'send_to_session'] as FilterAction[]).map(v => (
            <button
              key={v}
              onClick={() => setActionFilter(v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                actionFilter === v ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {v === 'all' ? tr('全部', 'All') : v === 'send_to_main' ? tr('→ 主会话', `→ Main ${term('session')}`) : tr('→ 子会话', `→ Child ${term('session')}`)}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-center">
          <span className="text-sm text-gray-600">{tr('结果', 'Result')}:</span>
          {(['all', 'success', 'failed'] as FilterSuccess[]).map(v => (
            <button
              key={v}
              onClick={() => setSuccessFilter(v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                successFilter === v ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {v === 'all' ? tr('全部', 'All') : v === 'success' ? tr('成功', 'Success') : tr('失败', 'Failed')}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead>
            <tr className="bg-gray-50">
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{tr('时间', 'Time')}</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{tr('任务 ID', 'Task ID')}</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{tr('动作', 'Action')}</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{term('session')}</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{tr('结果', 'Result')}</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{tr('原因', 'Reason')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {filtered.length === 0 ? (
              <tr><td colSpan={6} className="px-6 py-12 text-center">
                <div className="text-gray-400">
                  <svg className="w-10 h-10 mx-auto mb-3 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                  <p className="text-sm font-medium">{tr(`暂无${term('route')}历史`, `No ${term('route')} history`)}</p>
                </div>
              </td></tr>
            ) : (
              filtered.map((entry, i) => <RouteRow key={`${entry.taskId}-${entry.timestamp}-${i}`} entry={entry} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RouteRow({ entry }: { entry: RouteHistoryEntry }) {
  const { tr, term } = useI18n();
  return (
    <tr className="hover:bg-gray-100 transition-colors">
      <td className="px-6 py-3 text-sm text-gray-600">{new Date(entry.timestamp).toLocaleTimeString()}</td>
      <td className="px-6 py-3 text-sm font-mono text-primary-600 hover:text-primary-800">
        <Link to={`/tasks/${entry.taskId}`}>{entry.taskId.slice(0, 8)}...</Link>
      </td>
      <td className="px-6 py-3">
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
          entry.action === 'send_to_main' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'
        }`}>
          {entry.action === 'send_to_main' ? tr('→ 主会话', `→ Main ${term('session')}`) : tr('→ 子会话', `→ Child ${term('session')}`)}
        </span>
      {entry.fallback && (
        <span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800">
            {tr('回退', 'Fallback')}
        </span>
      )}
      </td>
      <td className="px-6 py-3 text-sm font-mono text-gray-600 max-w-[150px] truncate">
        {entry.sessionKey || '—'}
      </td>
      <td className="px-6 py-3">
        <StatusBadge status={entry.success ? 'completed' : 'failed'} />
      </td>
      <td className="px-6 py-3 text-sm text-gray-600 max-w-[200px] truncate" title={entry.reason}>
        {entry.reason}
        {entry.error && <span className="block text-xs text-red-500">{entry.error}</span>}
      </td>
    </tr>
  );
}
