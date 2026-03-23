import { useMemo, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTasks } from '@/hooks/useTasks';
import { useMessages } from '@/hooks/useMessages';
import { useBots } from '@/hooks/useBots';
import { useSessions } from '@/hooks/useRouterStatus';
import { StatusBadge } from '@/components/StatusBadge';
import { TaskActions } from '@/components/TaskActions';
import { TaskTimeline } from '@/components/TaskTimeline';
import { BotAvatar } from '@/components/BotAvatar';
import { TaskParticipants } from '@/components/workspace/TaskParticipants';
import { formatDate, formatDuration } from '@/lib/utils';
import { routerApi } from '@/lib/router-api';
import { useIdentity } from '@/lib/identity';

type ActivityExportNode =
  | { kind: 'task'; createdAt: string; task: TaskLike; children: ActivityExportNode[] }
  | { kind: 'message'; createdAt: string; message: MessageLike };

type TaskLike = ReturnType<typeof normalizeTaskForExport>;
type MessageLike = ReturnType<typeof normalizeMessageForExport>;

function normalizeTaskForExport(task: any) {
  return {
    id: task.id,
    parentTaskId: task.parentTaskId || null,
    type: task.type || 'new',
    status: task.status,
    priority: task.priority,
    title: task.title || null,
    prompt: task.prompt || null,
    capability: task.capability || 'general',
    fromBotId: task.fromBotId,
    fromBotName: task.fromBotName || null,
    toBotId: task.toBotId,
    toBotName: task.toBotName || null,
    senderSessionKey: task.senderSessionKey || null,
    executorSessionKey: task.executorSessionKey || null,
    createdAt: task.createdAt,
    acceptedAt: task.acceptedAt || null,
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    submittedAt: task.submittedAt || null,
    submittedResult: task.submittedResult ?? null,
    result: task.result ?? null,
    error: task.error ?? null,
    parameters: task.parameters ?? {},
    rejectionReason: task.rejectionReason || null,
  };
}

function normalizeMessageForExport(message: any) {
  return {
    messageId: message.messageId,
    taskId: message.taskId || null,
    type: message.type,
    contentType: message.contentType,
    priority: message.priority,
    status: message.status,
    fromBotId: message.fromBotId,
    fromBotName: message.fromBotName || null,
    toBotId: message.toBotId,
    toBotName: message.toBotName || null,
    content: message.content ?? null,
    traceId: message.traceId || null,
    createdAt: message.createdAt,
    readAt: message.readAt || null,
  };
}

function buildActivityTreeExport(focusTaskId: string, tasks: any[], messages: any[]): { rootTaskId: string; tree: ActivityExportNode | null } {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  if (!taskMap.has(focusTaskId)) {
    return { rootTaskId: focusTaskId, tree: null };
  }

  let rootTaskId = focusTaskId;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(rootTaskId)) break;
    visited.add(rootTaskId);
    const t = taskMap.get(rootTaskId);
    if (!t?.parentTaskId || !taskMap.has(t.parentTaskId)) break;
    rootTaskId = t.parentTaskId;
  }

  const childrenMap = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.parentTaskId && taskMap.has(t.parentTaskId)) {
      const arr = childrenMap.get(t.parentTaskId) || [];
      arr.push(t.id);
      childrenMap.set(t.parentTaskId, arr);
    }
  }

  const msgByTask = new Map<string, any[]>();
  for (const m of messages) {
    if (!m.taskId) continue;
    const arr = msgByTask.get(m.taskId) || [];
    arr.push(m);
    msgByTask.set(m.taskId, arr);
  }

  const ts = (dateStr?: string) => new Date(dateStr || 0).getTime();
  const build = (taskId: string, depth: number): ActivityExportNode | null => {
    if (depth > 20) return null;
    const task = taskMap.get(taskId);
    if (!task) return null;

    const children: ActivityExportNode[] = [];
    const childIds = childrenMap.get(taskId) || [];
    for (const childId of childIds) {
      const child = build(childId, depth + 1);
      if (child) children.push(child);
    }

    const msgs = msgByTask.get(taskId) || [];
    for (const m of msgs) {
      children.push({
        kind: 'message',
        createdAt: m.createdAt,
        message: normalizeMessageForExport(m),
      });
    }

    children.sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
    return {
      kind: 'task',
      createdAt: task.createdAt,
      task: normalizeTaskForExport(task),
      children,
    };
  };

  return { rootTaskId, tree: build(rootTaskId, 0) };
}

function downloadJsonFile(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function TaskDetail() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const { data: tasks = [], isLoading } = useTasks();
  const { data: messages = [] } = useMessages();
  const { data: bots = [] } = useBots();
  const { data: sessions = [] } = useSessions();
  const { me } = useIdentity();
  const [panelOpen, setPanelOpen] = useState(false);
  const handlePanelChange = useCallback((open: boolean) => setPanelOpen(open), []);
  const [resumeInput, setResumeInput] = useState('');
  const [resumeLoading, setResumeLoading] = useState(false);
  const [continuePrompt, setContinuePrompt] = useState('');
  const [continueLoading, setContinueLoading] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const rawTask = tasks.find(t => t.id === taskId);

  const handleResume = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskId || !rawTask) return;
    setResumeLoading(true);
    try {
      await routerApi.resumeTask(taskId, resumeInput || undefined, rawTask.fromBotId);
      setResumeInput('');
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    } catch {
      // error handled silently, TaskActions modal is the fallback
    } finally {
      setResumeLoading(false);
    }
  }, [taskId, rawTask, resumeInput, queryClient]);

  const handleContinue = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskId || !rawTask || !continuePrompt.trim()) return;
    setContinueLoading(true);
    setContinueError(null);
    try {
      const result = await routerApi.continueTask(taskId, continuePrompt, rawTask.fromBotId);
      if (!result.success) {
        setContinueError(`Continue failed: ${result.reason || 'unknown error'}`);
        return;
      }
      setContinuePrompt('');
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    } catch (err) {
      setContinueError(`Continue failed: ${(err as Error).message}`);
    } finally {
      setContinueLoading(false);
    }
  }, [taskId, rawTask, continuePrompt, queryClient]);

  // Build bot lookup map for avatar enrichment
  const botMap = useMemo(() => {
    const map = new Map<string, { name: string; avatarColor?: string; avatarUrl?: string }>();
    for (const bot of bots) {
      map.set(bot.id, { name: bot.name, avatarColor: bot.avatarColor, avatarUrl: bot.avatarUrl });
    }
    return map;
  }, [bots]);

  // Enrich task with bot avatar data
  const task = useMemo(() => {
    if (!rawTask) return null;
    const fromBot = botMap.get(rawTask.fromBotId);
    const toBot = botMap.get(rawTask.toBotId);
    return {
      ...rawTask,
      fromBotName: rawTask.fromBotName || fromBot?.name,
      fromAvatarColor: rawTask.fromAvatarColor || fromBot?.avatarColor,
      fromAvatarUrl: rawTask.fromAvatarUrl || fromBot?.avatarUrl,
      toBotName: rawTask.toBotName || toBot?.name,
      toAvatarColor: rawTask.toAvatarColor || toBot?.avatarColor,
      toAvatarUrl: rawTask.toAvatarUrl || toBot?.avatarUrl,
    };
  }, [rawTask, botMap]);
  const session = task?.executorSessionKey
    ? sessions.find(s => s.sessionKey === task.executorSessionKey)
    : null;

  // Enrich all tasks with bot data for the timeline
  const enrichedTasks = useMemo(
    () =>
      tasks.map((t) => {
        const fromBot = botMap.get(t.fromBotId);
        const toBot = botMap.get(t.toBotId);
        return {
          ...t,
          fromBotName: t.fromBotName || fromBot?.name,
          fromAvatarColor: t.fromAvatarColor || fromBot?.avatarColor,
          fromAvatarUrl: t.fromAvatarUrl || fromBot?.avatarUrl,
          toBotName: t.toBotName || toBot?.name,
          toAvatarColor: t.toAvatarColor || toBot?.avatarColor,
          toAvatarUrl: t.toAvatarUrl || toBot?.avatarUrl,
        };
      }),
    [tasks, botMap],
  );

  // Enrich messages with bot data for the timeline
  const enrichedMessages = useMemo(
    () =>
      messages.map((m) => {
        const fromBot = botMap.get(m.fromBotId);
        const toBot = botMap.get(m.toBotId);
        return {
          ...m,
          fromBotName: m.fromBotName || fromBot?.name,
          fromAvatarColor: m.fromAvatarColor || fromBot?.avatarColor,
          fromAvatarUrl: m.fromAvatarUrl || fromBot?.avatarUrl,
          toBotName: m.toBotName || toBot?.name,
          toAvatarColor: m.toAvatarColor || toBot?.avatarColor,
          toAvatarUrl: m.toAvatarUrl || toBot?.avatarUrl,
        };
      }),
    [messages, botMap],
  );

  // Check if this task has related content (parent, children, or messages)
  const hasActivity = task && (
    task.parentTaskId ||
    tasks.some(t => t.parentTaskId === task.id) ||
    messages.some(m => m.taskId === task.id)
  );

  const activityExport = useMemo(() => {
    if (!task) return null;
    const { rootTaskId, tree } = buildActivityTreeExport(task.id, enrichedTasks, enrichedMessages);
    if (!tree) return null;

    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      focusTaskId: task.id,
      rootTaskId,
      tree,
    };
  }, [task, enrichedTasks, enrichedMessages]);

  const handleDownloadActivity = useCallback(() => {
    if (!task || !activityExport) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadJsonFile(`activity-tree-${task.id}-${timestamp}.json`, activityExport);
  }, [task, activityExport]);

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-yellow-50 rounded-xl p-6 text-center">
          <p className="text-yellow-800">Task not found: {taskId}</p>
          <button onClick={() => navigate('/tasks')} className="mt-3 text-sm text-primary-600 hover:underline">
            Back to tasks
          </button>
        </div>
      </div>
    );
  }

  const duration = task.startedAt && task.completedAt
    ? new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()
    : null;

  // Timeline steps
  const timeline = [
    { label: 'Created', time: task.createdAt, active: true },
    { label: 'Started', time: task.startedAt, active: !!task.startedAt },
    { label: task.status === 'failed' ? 'Failed' : task.status === 'timeout' ? 'Timed Out' : 'Completed',
      time: task.completedAt, active: !!task.completedAt },
  ];

  return (
    <div className={`mx-auto px-4 sm:px-6 lg:px-8 py-8 transition-all duration-300 ${panelOpen ? 'max-w-full' : 'max-w-4xl'}`}>
      {/* Back + Header */}
      <button onClick={() => navigate('/tasks')} className="text-sm text-gray-500 hover:text-gray-700 mb-4 inline-block">
        &larr; Back to tasks
      </button>

      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-2xl font-bold text-gray-900">{task.title || task.prompt || task.capability || 'Task'}</h2>
            <StatusBadge status={task.status} />
            <StatusBadge status={task.priority} />
          </div>
          {task.capability && task.capability !== 'general' && <p className="text-sm text-gray-500 mb-1">{task.capability}</p>}
          <p className="text-sm text-gray-500 font-mono">{task.id}</p>
        </div>
        <TaskActions task={task} />
      </div>

      <div className="space-y-6">
        {/* Timeline */}
        <div className="bg-white rounded-xl p-6 card-gradient">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Timeline</h3>
          <div className="flex items-center gap-0">
            {timeline.map((step, i) => (
              <div key={step.label} className="flex items-center">
                <div className="flex flex-col items-center">
                  <div className={`w-3 h-3 rounded-full ${step.active ? 'bg-primary-600' : 'bg-gray-300'}`} />
                  <p className="text-xs font-medium text-gray-700 mt-1">{step.label}</p>
                  <p className="text-xs text-gray-500">{step.time ? formatDate(step.time) : '—'}</p>
                </div>
                {i < timeline.length - 1 && (
                  <div className={`w-24 h-0.5 mx-2 ${step.active ? 'bg-primary-300' : 'bg-gray-200'}`} />
                )}
              </div>
            ))}
          </div>
          {duration !== null && (
            <p className="text-xs text-gray-500 mt-3">Duration: {formatDuration(duration)}</p>
          )}
        </div>

        {/* Waiting for Input Banner — only shown to the human whose bot requested input */}
        {(() => {
          if (task.status !== 'waiting_for_input' || !me?.currentBot?.id) return null;
          const result = task.result as any;
          const requests: Array<{ botId: string; reason: string }> = result?.waitingRequests || [];
          const myRequest = requests.find((r: any) => r.botId === me.currentBot!.id)
            || (result?.waitingRequestedBy === me.currentBot.id ? { botId: me.currentBot.id, reason: result?.waitingReason } : null);
          if (!myRequest) return null;
          return (
          <div className="bg-amber-50 rounded-xl p-6">
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse mt-2" />
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-amber-800 mb-1">Waiting for Human Input</h3>
                <p className="text-sm text-amber-900 mb-3">{myRequest.reason}</p>
                <form onSubmit={handleResume} className="flex gap-2">
                  <input
                    type="text"
                    value={resumeInput}
                    onChange={(e) => setResumeInput(e.target.value)}
                    placeholder="Type your reply..."
                    className="flex-1 px-3 py-2 text-sm bg-amber-50 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
                    disabled={resumeLoading}
                  />
                  <button
                    type="submit"
                    disabled={resumeLoading}
                    className="px-4 py-2 text-sm font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-50"
                  >
                    {resumeLoading ? 'Sending...' : 'Send & Resume'}
                  </button>
                </form>
              </div>
            </div>
          </div>
          );
        })()}

        {/* Pending Review Banner — shown when executor submitted result for review */}
        {task.status === 'pending_review' && (
          <div className="bg-indigo-50 rounded-xl p-6">
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse mt-2" />
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-indigo-800 mb-1">Pending Review</h3>
                <p className="text-sm text-indigo-700 mb-3">
                  The executor submitted a result. Review decisions must go through your delegator bot session (proxy-only), not direct dashboard approve/reject.
                </p>
                {task.submittedResult !== undefined && task.submittedResult !== null && (
                  <div className="mb-3">
                    <p className="text-xs font-medium text-indigo-600 mb-1">Submitted Result:</p>
                    <pre className="bg-indigo-100 rounded p-3 text-xs overflow-x-auto max-h-48">
                      {typeof task.submittedResult === 'object' ? JSON.stringify(task.submittedResult, null, 2) : String(task.submittedResult)}
                    </pre>
                  </div>
                )}
                {task.submittedAt && (
                  <p className="text-xs text-indigo-500 mb-3">Submitted at: {formatDate(task.submittedAt)}</p>
                )}
                {task.rejectionReason && (
                  <p className="text-xs text-red-600 mb-3">Previous rejection: {task.rejectionReason}</p>
                )}
                <p className="text-xs text-indigo-600">
                  If rework is needed, tell your own bot to reject with reason. If accepted, tell your own bot to approve.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Continue Task Banner — shown for completed/failed/timeout tasks */}
        {['completed', 'failed', 'timeout'].includes(task.status) && (
          <div className="bg-green-50 rounded-xl p-6">
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-green-400 mt-2" />
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-green-800 mb-1">Continue this task</h3>
                <p className="text-sm text-green-700 mb-3">Provide new instructions to reopen and continue this task.</p>
                <form onSubmit={handleContinue} className="space-y-2">
                  <textarea
                    value={continuePrompt}
                    onChange={(e) => setContinuePrompt(e.target.value)}
                    placeholder="Enter additional instructions..."
                    className="w-full px-3 py-2 text-sm bg-green-50 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400"
                    rows={3}
                  />
                  {continueError && (
                    <p className="text-sm text-red-600">{continueError}</p>
                  )}
                  <button
                    type="submit"
                    disabled={continueLoading || !continuePrompt.trim()}
                    className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50"
                  >
                    {continueLoading ? 'Continuing...' : 'Continue Task'}
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {/* Task Participants */}
        <TaskParticipants task={task} allTasks={tasks} bots={bots} />

        {/* Bot Info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white rounded-xl p-4 card-gradient">
            <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">From</h4>
            <div className="flex items-center gap-3">
              <BotAvatar name={task.fromBotName || task.fromBotId} id={task.fromBotId} avatarColor={task.fromAvatarColor} avatarUrl={task.fromAvatarUrl} size="lg" />
              <div>
                <p className="font-medium text-gray-900">{task.fromBotName || task.fromBotId}</p>
                <p className="text-xs text-gray-500 font-mono mt-0.5">{task.fromBotId}</p>
                {task.senderSessionKey && (
                  <p className="text-xs text-gray-500 mt-0.5">Session: <code className="font-mono bg-gray-50 px-1 rounded">{task.senderSessionKey}</code></p>
                )}
              </div>
            </div>
          </div>
          <div className="bg-white rounded-xl p-4 card-gradient">
            <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">To</h4>
            <div className="flex items-center gap-3">
              <BotAvatar name={task.toBotName || task.toBotId} id={task.toBotId} avatarColor={task.toAvatarColor} avatarUrl={task.toAvatarUrl} size="lg" />
              <div>
                <p className="font-medium text-gray-900">{task.toBotName || task.toBotId}</p>
                <p className="text-xs text-gray-500 font-mono mt-0.5">{task.toBotId}</p>
                {task.executorSessionKey && (
                  <p className="text-xs text-gray-500 mt-0.5">Session: <code className="font-mono bg-gray-50 px-1 rounded">{task.executorSessionKey}</code></p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Session State (from Router) */}
        {session && (
          <div className="bg-white rounded-xl p-6 card-gradient">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Session State</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-gray-500">State: </span>
                <StatusBadge status={session.sessionState} />
              </div>
              <div>
                <span className="text-gray-500">Alive: </span>
                <span className={session.details.alive ? 'text-green-600' : 'text-red-600'}>
                  {session.details.alive ? 'Yes' : 'No'}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Age: </span>
                <span>{session.details.ageMs ? formatDuration(session.details.ageMs) : '—'}</span>
              </div>
              <div>
                <span className="text-gray-500">Model: </span>
                <span>{session.details.jsonlAnalysis?.model || '—'}</span>
              </div>
            </div>
          </div>
        )}

        {/* Prompt */}
        {task.prompt && (
          <div className="bg-white rounded-xl p-6 card-gradient">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Prompt</h3>
            <pre className="bg-gray-50 rounded p-3 text-xs overflow-x-auto max-h-48 whitespace-pre-wrap break-words">
              {task.prompt}
            </pre>
          </div>
        )}

        {/* Parameters */}
        {Object.keys(task.parameters || {}).length > 0 && (
          <div className="bg-white rounded-xl p-6 card-gradient">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Parameters</h3>
            <pre className="bg-gray-50 rounded p-3 text-xs overflow-x-auto max-h-48">
              {JSON.stringify(task.parameters, null, 2)}
            </pre>
          </div>
        )}

        {/* Result */}
        {task.result !== undefined && task.result !== null && (
          <div className="bg-white rounded-xl p-6 card-gradient">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Result</h3>
            <pre className="bg-green-50 rounded p-3 text-xs overflow-x-auto max-h-48">
              {typeof task.result === 'object' ? JSON.stringify(task.result, null, 2) : String(task.result)}
            </pre>
          </div>
        )}

        {/* Error */}
        {task.error && (
          <div className="bg-white rounded-xl p-6 card-gradient">
            <h3 className="text-sm font-semibold text-red-700 mb-3">Error</h3>
            <pre className="bg-red-50 rounded p-3 text-xs text-red-800 overflow-x-auto max-h-48">
              {typeof task.error === 'object' ? JSON.stringify(task.error, null, 2) : String(task.error)}
            </pre>
          </div>
        )}

        {/* Activity Tree (sub-tasks + messages, hierarchical + chronological) */}
        {hasActivity && (
          <div className="bg-white rounded-xl p-6 card-gradient">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-700">Activity Tree</h3>
              <button
                type="button"
                onClick={handleDownloadActivity}
                disabled={!activityExport}
                className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Download Task History
              </button>
            </div>
            <TaskTimeline
              focusTaskId={task.id}
              tasks={enrichedTasks}
              messages={enrichedMessages}
              onPanelChange={handlePanelChange}
            />
          </div>
        )}
      </div>
    </div>
  );
}
