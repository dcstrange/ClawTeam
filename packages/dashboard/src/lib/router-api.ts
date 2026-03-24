import { ROUTER_BASE } from './config';
import type { RouterStatus, SessionStatus, TrackedTask, RouteHistoryEntry } from './types';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Router API error: ${res.status} ${res.statusText}`);
  return res.json();
}

/** Read stored API key for authenticated API Server calls */
function getAuthHeaders(): Record<string, string> {
  const apiKey = localStorage.getItem('clawteam_api_key');
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export const routerApi = {
  getStatus: () =>
    fetchJson<RouterStatus>(`${ROUTER_BASE}/status`),

  getSessions: () =>
    fetchJson<{ sessions: SessionStatus[] }>(`${ROUTER_BASE}/sessions`)
      .then(r => r.sessions),

  getTrackedTasks: () =>
    fetchJson<{ tasks: TrackedTask[] }>(`${ROUTER_BASE}/tasks`)
      .then(r => r.tasks),

  getRouteHistory: () =>
    fetchJson<{ entries: RouteHistoryEntry[] }>(`${ROUTER_BASE}/routes/history`)
      .then(r => r.entries),

  nudgeTask: (taskId: string) =>
    fetchJson<{ success: boolean; reason: string }>(
      `${ROUTER_BASE}/tasks/${taskId}/nudge`,
      { method: 'POST' },
    ),

  cancelTask: (taskId: string, reason: string) =>
    fetchJson<{ success: boolean; apiCancelled: boolean; sessionNotified: boolean; reason: string }>(
      `${ROUTER_BASE}/tasks/${taskId}/cancel`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) },
    ),

  resetMainSession: () =>
    fetchJson<{ success: boolean; newSessionId?: string; message?: string }>(
      `${ROUTER_BASE}/sessions/main/reset`,
      { method: 'POST' },
    ),

  createTask: (
    prompt: string,
    priority = 'normal',
    fromBotId?: string,
    options?: {
      title?: string;
      capability?: string;
      parameters?: Record<string, any>;
      type?: string;
      parentTaskId?: string;
      timeoutSeconds?: number;
    },
  ) =>
    fetchJson<{ success: boolean; taskId?: string; data?: any }>(
      '/api/tasks/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...(fromBotId ? { 'X-Bot-Id': fromBotId } : {}) },
        body: JSON.stringify({
          prompt,
          priority,
          ...(options?.title ? { title: options.title } : {}),
          ...(options?.capability ? { capability: options.capability } : {}),
          ...(options?.parameters ? { parameters: options.parameters } : {}),
          ...(options?.type ? { type: options.type } : {}),
          ...(options?.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
          ...(typeof options?.timeoutSeconds === 'number' ? { timeoutSeconds: options.timeoutSeconds } : {}),
        }),
      },
    ),

  delegateIntent: (taskId: string, fromBotId?: string) =>
    fetchJson<{ success: boolean; data?: { taskId: string; message: string }; message?: string }>(
      `/api/tasks/${taskId}/delegate-intent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...(fromBotId ? { 'X-Bot-Id': fromBotId } : {}) },
        body: JSON.stringify({}),
      },
    ),

  resumeTask: (taskId: string, humanInput?: string, callerBotId?: string) =>
    fetchJson<{ success: boolean }>(`/api/tasks/${taskId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...(callerBotId ? { 'X-Bot-Id': callerBotId } : {}) },
      body: JSON.stringify(humanInput ? { input: humanInput } : {}),
    }),

  continueTask: (taskId: string, prompt: string, callerBotId?: string) =>
    fetchJson<{ success: boolean; reason?: string }>(`/api/tasks/${taskId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...(callerBotId ? { 'X-Bot-Id': callerBotId } : {}) },
      body: JSON.stringify({ input: prompt }),
    }),

};
