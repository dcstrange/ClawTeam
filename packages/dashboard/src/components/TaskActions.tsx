import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ConfirmModal } from './ConfirmModal';
import { routerApi } from '@/lib/router-api';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/config';
import type { Task } from '@/lib/types';
import { useI18n } from '@/lib/i18n';

interface TaskActionsProps {
  task: Task;
}

export function TaskActions({ task }: TaskActionsProps) {
  const { tr, term } = useI18n();
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'retry' | 'nudge' | 'continue' | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [continuePrompt, setContinuePrompt] = useState('');
  const queryClient = useQueryClient();

  const canCancel = ['pending', 'accepted', 'processing', 'waiting_for_input', 'pending_review'].includes(task.status);
  const canRetry = ['failed', 'timeout', 'cancelled'].includes(task.status);
  const canNudge = ['accepted', 'processing'].includes(task.status);
  const canContinue = ['completed', 'failed', 'timeout'].includes(task.status);

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    try {
      switch (confirmAction) {
        case 'cancel': {
          // Cancel via API server directly
          const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.cancelTask(task.id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: '从仪表盘取消' }),
          });
          const result = await res.json();
          if (!result.success) {
            setError(`${tr('取消失败', 'Cancel failed')}: ${result.error?.message || tr('未知错误', 'Unknown error')}`);
            return;
          }
          break;
        }
        case 'retry': {
          await fetch(`${API_BASE_URL}${API_ENDPOINTS.createTask}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Bot-Id': task.fromBotId,
            },
            body: JSON.stringify({
              toBotId: task.toBotId,
              capability: task.capability,
              parameters: task.parameters,
              priority: task.priority,
              type: task.type || 'new',
              parentTaskId: task.id,
            }),
          });
          break;
        }
        case 'nudge': {
          await routerApi.nudgeTask(task.id);
          break;
        }
        case 'continue': {
          const result = await routerApi.continueTask(task.id, continuePrompt, task.fromBotId);
          if (!result.success) {
            const msg = result.reason === 'session_lost'
              ? tr('会话已丢失：该任务对应的机器人会话已不再活跃。请重启机器人后重试。', 'Session is lost: the related bot session is no longer active. Restart the bot and try again.')
              : `${tr('继续失败', 'Continue failed')}: ${result.reason || tr('未知错误', 'Unknown error')}`;
            setError(msg);
            return;
          }
          setContinuePrompt('');
          break;
        }
      }
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['router-tracked-tasks'] });
    } catch (err) {
      setError(`${tr('操作失败', 'Action failed')}: ${(err as Error).message}`);
      return;
    } finally {
      setLoading(false);
    }
    setConfirmAction(null);
  }

  const modalConfig = {
    cancel: {
      title: tr('取消任务', 'Cancel Task'),
      description: tr(`确认取消任务 ${task.id.slice(0, 8)}...（${task.capability}）吗？`, `Cancel task ${task.id.slice(0, 8)}... (${task.capability})?`),
      confirmLabel: tr('确认取消', 'Confirm Cancel'),
      confirmClassName: 'bg-red-600 hover:bg-red-700',
    },
    retry: {
      title: tr('重试任务', 'Retry Task'),
      description: tr(`确认基于 ${task.id.slice(0, 8)}...（${task.capability}）创建同参数新任务吗？`, `Create a new task from ${task.id.slice(0, 8)}... (${task.capability}) with the same parameters?`),
      confirmLabel: tr('确认重试', 'Confirm Retry'),
      confirmClassName: 'bg-blue-600 hover:bg-blue-700',
    },
    nudge: {
      title: tr('催办任务', 'Nudge Task'),
      description: tr(`确认向处理 ${task.id.slice(0, 8)}...（${task.capability}）的会话发送催办消息吗？`, `Send a nudge to the ${term('session')} processing ${task.id.slice(0, 8)}... (${task.capability})?`),
      confirmLabel: tr('发送催办', 'Send Nudge'),
      confirmClassName: 'bg-yellow-600 hover:bg-yellow-700',
    },
    continue: {
      title: tr('继续任务', 'Continue Task'),
      description: tr(`确认使用新指令继续任务 ${task.id.slice(0, 8)}... 吗？`, `Continue task ${task.id.slice(0, 8)}... with new instructions?`),
      confirmLabel: tr('确认继续', 'Confirm Continue'),
      confirmClassName: 'bg-green-600 hover:bg-green-700',
    },
  };

  return (
    <>
      <div className="flex gap-2">
        {canCancel && (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmAction('cancel'); }}
            className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 rounded-lg hover:bg-red-100"
          >
            {tr('取消', 'Cancel')}
          </button>
        )}
        {canRetry && (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmAction('retry'); }}
            className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100"
          >
            {tr('重试', 'Retry')}
          </button>
        )}
        {canNudge && (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmAction('nudge'); }}
            className="px-3 py-1.5 text-xs font-medium text-yellow-700 bg-yellow-50 rounded-lg hover:bg-yellow-100"
          >
            {tr('催办', 'Nudge')}
          </button>
        )}
        {canContinue && (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmAction('continue'); }}
            className="px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 rounded-lg hover:bg-green-100"
          >
            {tr('继续', 'Continue')}
          </button>
        )}
      </div>

      {confirmAction && (
        <ConfirmModal
          isOpen={!!confirmAction}
          {...modalConfig[confirmAction]}
          onConfirm={handleConfirm}
          onCancel={() => { setConfirmAction(null); setError(null); }}
        >
          {loading && (
            <p className="text-sm text-gray-500 animate-pulse">{tr('处理中...', 'Processing...')}</p>
          )}
          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}
          {confirmAction === 'nudge' && task.executorSessionKey && (
            <div className="mt-2 p-2 bg-gray-50 rounded text-xs">
              <span className="text-gray-500">{tr(`目标${term('session')}`, `Target ${term('session')}`)}: </span>
              <code className="font-mono">{task.executorSessionKey}</code>
            </div>
          )}
          {confirmAction === 'continue' && (
            <textarea
              value={continuePrompt}
              onChange={(e) => setContinuePrompt(e.target.value)}
              placeholder={tr('输入额外说明...', 'Add extra instructions...')}
              className="mt-2 w-full px-3 py-2 text-sm bg-gray-50 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400"
              rows={3}
            />
          )}
        </ConfirmModal>
      )}
    </>
  );
}
