import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTasks } from '@/hooks/useTasks';
import { useIdentity } from '@/lib/identity';
import { routerApi } from '@/lib/router-api';
import { StatusBadge } from '@/components/StatusBadge';
import { BotAvatar } from '@/components/BotAvatar';
import { Link } from 'react-router-dom';
import type { Task } from '@/lib/types';

interface InboxItemProps {
  task: Task;
  isExecutor: boolean;
  waitingReason: string;
  currentBotId: string;
  onResume: () => void;
}

function InboxItem({ task, onResume, isExecutor, waitingReason, currentBotId }: InboxItemProps) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await routerApi.resumeTask(task.id, input || undefined, currentBotId);
      setInput('');
      onResume();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-white rounded-xl p-5 card-gradient">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          <Link
            to={`/tasks/${task.id}`}
            className="text-sm font-mono text-gray-500 hover:text-primary-600"
          >
            {task.id.slice(0, 8)}...
          </Link>
          <StatusBadge status={task.status} />
        </div>
        <span className="text-xs text-gray-400">
          {task.capability || 'general'}
        </span>
      </div>

      <div className="flex items-center gap-2 text-sm text-gray-600 mb-3">
        <span>{isExecutor ? 'From:' : 'Executor:'}</span>
        <BotAvatar
          name={isExecutor ? (task.fromBotName || task.fromBotId) : (task.toBotName || task.toBotId)}
          id={isExecutor ? task.fromBotId : task.toBotId}
          avatarColor={isExecutor ? task.fromAvatarColor : task.toAvatarColor}
          avatarUrl={isExecutor ? task.fromAvatarUrl : task.toAvatarUrl}
          size="sm"
        />
        <span className="font-medium">
          {isExecutor
            ? (task.fromBotName || task.fromBotId.slice(0, 8))
            : (task.toBotName || task.toBotId.slice(0, 8))}
        </span>
      </div>

      <div className="bg-amber-50 rounded-xl p-3 mb-4">
        <p className="text-sm font-medium text-amber-800 mb-1">Bot is asking:</p>
        <p className="text-sm text-amber-900">{waitingReason}</p>
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your reply..."
          className="flex-1 px-3 py-2 text-sm bg-gray-50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 transition-shadow"
        />
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50"
        >
          {loading ? 'Sending...' : input ? 'Send & Resume' : 'Resume'}
        </button>
      </form>

      {error && (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      )}
    </div>
  );
}

export function Inbox() {
  const { data: tasks = [] } = useTasks();
  const { me } = useIdentity();
  const queryClient = useQueryClient();

  // Filter tasks waiting for human input where the current user's bot has a pending request.
  // Uses waitingRequests array (supports concurrent requests from multiple bots).
  // Fallback: if waitingRequests is not set (old tasks), check legacy waitingRequestedBy.
  const waitingItems = tasks.flatMap((t) => {
    if (t.status !== 'waiting_for_input' || !me?.currentBot?.id) return [];
    const result = t.result as any;
    const requests: Array<{ botId: string; reason: string }> = result?.waitingRequests || [];
    const myRequest = requests.find((r: any) => r.botId === me.currentBot!.id);
    if (myRequest) {
      return [{ task: t, reason: myRequest.reason }];
    }
    // Legacy fallback: single waitingRequestedBy field
    const requestedBy = result?.waitingRequestedBy;
    if (requestedBy === me.currentBot.id) {
      return [{ task: t, reason: result?.waitingReason || 'No reason provided' }];
    }
    // Very old tasks: no requestedBy at all, show to both sides
    if (!requestedBy && !requests.length) {
      if (t.toBotId === me.currentBot.id || t.fromBotId === me.currentBot.id) {
        return [{ task: t, reason: result?.waitingReason || 'No reason provided' }];
      }
    }
    return [];
  });

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Inbox</h2>
        <p className="text-gray-600 mt-1">
          Tasks waiting for your input ({waitingItems.length})
        </p>
      </div>

      {waitingItems.length === 0 ? (
        <div className="empty-state">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>
          <p className="text-gray-500 text-lg font-medium">No pending requests</p>
          <p className="text-gray-400 text-sm mt-1">
            When a bot needs your input, it will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {waitingItems.map(({ task, reason }, i) => (
            <div
              key={task.id}
              className="animate-stagger"
              style={{ '--stagger-index': i } as React.CSSProperties}
            >
              <InboxItem
                task={task}
                isExecutor={task.toBotId === me?.currentBot?.id}
                waitingReason={reason}
                currentBotId={me?.currentBot?.id || task.fromBotId}
                onResume={() => queryClient.invalidateQueries({ queryKey: ['tasks'] })}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
