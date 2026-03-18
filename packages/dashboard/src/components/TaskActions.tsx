import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ConfirmModal } from './ConfirmModal';
import { routerApi } from '@/lib/router-api';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/config';
import type { Task } from '@/lib/types';

interface TaskActionsProps {
  task: Task;
}

export function TaskActions({ task }: TaskActionsProps) {
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'retry' | 'nudge' | 'continue' | 'approve' | 'reject' | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [continuePrompt, setContinuePrompt] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const queryClient = useQueryClient();

  const canCancel = ['pending', 'accepted', 'processing', 'waiting_for_input', 'pending_review'].includes(task.status);
  const canRetry = ['failed', 'timeout', 'cancelled'].includes(task.status);
  const canNudge = ['accepted', 'processing'].includes(task.status);
  const canContinue = ['completed', 'failed', 'timeout'].includes(task.status);
  const canApprove = task.status === 'pending_review';
  const canReject = task.status === 'pending_review';

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
            body: JSON.stringify({ reason: 'Cancelled from dashboard' }),
          });
          const result = await res.json();
          if (!result.success) {
            setError(`Cancel failed: ${result.error?.message || 'unknown error'}`);
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
              ? 'Session lost: the bot session for this task is no longer active. Please restart the bot and try again.'
              : `Continue failed: ${result.reason || 'unknown error'}`;
            setError(msg);
            return;
          }
          setContinuePrompt('');
          break;
        }
        case 'approve': {
          const result = await routerApi.approveTask(task.id);
          if (!result.success) {
            setError(`Approve failed: ${(result as any).error?.message || 'unknown error'}`);
            return;
          }
          break;
        }
        case 'reject': {
          const result = await routerApi.rejectTask(task.id, rejectReason || 'Rejected from dashboard');
          if (!result.success) {
            setError(`Reject failed: ${(result as any).error?.message || 'unknown error'}`);
            return;
          }
          setRejectReason('');
          break;
        }
      }
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['router-tracked-tasks'] });
    } catch (err) {
      setError(`${confirmAction} failed: ${(err as Error).message}`);
      return;
    } finally {
      setLoading(false);
    }
    setConfirmAction(null);
  }

  const modalConfig = {
    cancel: {
      title: 'Cancel Task',
      description: `Cancel task ${task.id.slice(0, 8)}... (${task.capability})?`,
      confirmLabel: 'Cancel Task',
      confirmClassName: 'bg-red-600 hover:bg-red-700',
    },
    retry: {
      title: 'Retry Task',
      description: `Create a new task with the same parameters as ${task.id.slice(0, 8)}... (${task.capability})?`,
      confirmLabel: 'Retry',
      confirmClassName: 'bg-blue-600 hover:bg-blue-700',
    },
    nudge: {
      title: 'Nudge Task',
      description: `Send a nudge message to the session handling ${task.id.slice(0, 8)}... (${task.capability})?`,
      confirmLabel: 'Send Nudge',
      confirmClassName: 'bg-yellow-600 hover:bg-yellow-700',
    },
    continue: {
      title: 'Continue Task',
      description: `Continue task ${task.id.slice(0, 8)}... with new instructions?`,
      confirmLabel: 'Continue Task',
      confirmClassName: 'bg-green-600 hover:bg-green-700',
    },
    approve: {
      title: 'Approve Task',
      description: `Approve the submitted result for task ${task.id.slice(0, 8)}... (${task.capability})? This will mark the task as completed.`,
      confirmLabel: 'Approve',
      confirmClassName: 'bg-green-600 hover:bg-green-700',
    },
    reject: {
      title: 'Reject Task',
      description: `Reject the submitted result for task ${task.id.slice(0, 8)}... (${task.capability})? The executor will be asked to rework.`,
      confirmLabel: 'Reject',
      confirmClassName: 'bg-red-600 hover:bg-red-700',
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
            Cancel
          </button>
        )}
        {canRetry && (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmAction('retry'); }}
            className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100"
          >
            Retry
          </button>
        )}
        {canNudge && (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmAction('nudge'); }}
            className="px-3 py-1.5 text-xs font-medium text-yellow-700 bg-yellow-50 rounded-lg hover:bg-yellow-100"
          >
            Nudge
          </button>
        )}
        {canContinue && (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmAction('continue'); }}
            className="px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 rounded-lg hover:bg-green-100"
          >
            Continue
          </button>
        )}
        {canApprove && (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmAction('approve'); }}
            className="px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 rounded-lg hover:bg-green-100"
          >
            Approve
          </button>
        )}
        {canReject && (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmAction('reject'); }}
            className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 rounded-lg hover:bg-red-100"
          >
            Reject
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
            <p className="text-sm text-gray-500 animate-pulse">Processing...</p>
          )}
          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}
          {confirmAction === 'nudge' && task.executorSessionKey && (
            <div className="mt-2 p-2 bg-gray-50 rounded text-xs">
              <span className="text-gray-500">Target session: </span>
              <code className="font-mono">{task.executorSessionKey}</code>
            </div>
          )}
          {confirmAction === 'continue' && (
            <textarea
              value={continuePrompt}
              onChange={(e) => setContinuePrompt(e.target.value)}
              placeholder="Enter additional instructions..."
              className="mt-2 w-full px-3 py-2 text-sm bg-gray-50 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400"
              rows={3}
            />
          )}
          {confirmAction === 'reject' && (
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason for rejection (optional)..."
              className="mt-2 w-full px-3 py-2 text-sm bg-gray-50 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-400"
              rows={3}
            />
          )}
        </ConfirmModal>
      )}
    </>
  );
}
