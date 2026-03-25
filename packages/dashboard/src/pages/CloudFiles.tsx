import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/config';
import { useIdentity } from '@/lib/identity';
import { useTasks } from '@/hooks/useTasks';
import type { FileNode } from '@/lib/types';
import { formatDate } from '@/lib/utils';

type CloudFileView = 'private' | 'public' | 'team' | 'task';

interface ApiSuccess<T> {
  success: true;
  data: T;
  traceId?: string;
}

interface ApiError {
  success: false;
  error?: {
    code?: string;
    message?: string;
  };
  traceId?: string;
}

interface FolderCrumb {
  id: string;
  name: string;
}

const viewOrder: CloudFileView[] = ['private', 'public', 'team', 'task'];
const viewLabels: Record<CloudFileView, string> = {
  private: 'My Private',
  public: 'My Public',
  team: 'Team Shared',
  task: 'Task Files',
};

function toErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const p = payload as ApiError;
    if (p.error?.message) return p.error.message;
  }
  return fallback;
}

function formatSize(sizeBytes: number | null): string {
  if (sizeBytes === null || Number.isNaN(sizeBytes)) return '-';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortId(value: string | null | undefined): string {
  if (!value) return '-';
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const idx = result.indexOf(',');
      if (idx < 0) {
        reject(new Error('Failed to parse uploaded file'));
        return;
      }
      resolve(result.slice(idx + 1));
    };
    reader.onerror = () => reject(new Error('Failed to read uploaded file'));
    reader.readAsDataURL(file);
  });
}

export function CloudFilesPage() {
  const { apiKey, me } = useIdentity();
  const { data: tasks = [] } = useTasks();

  const [view, setView] = useState<CloudFileView>('private');
  const [selectedBotId, setSelectedBotId] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [folderStack, setFolderStack] = useState<FolderCrumb[]>([]);
  const [items, setItems] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyAction, setBusyAction] = useState<{ nodeId: string; action: 'publish' | 'delete' } | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const ownedBots = useMemo(
    () => me?.ownedBots || (me?.currentBot ? [{ id: me.currentBot.id, name: me.currentBot.name, capabilities: [], status: 'online', createdAt: '' }] : []),
    [me],
  );

  const ownedBotIds = useMemo(() => {
    const ids = new Set<string>();
    for (const bot of ownedBots) ids.add(bot.id);
    if (me?.currentBot?.id) ids.add(me.currentBot.id);
    return ids;
  }, [ownedBots, me?.currentBot?.id]);

  const ownedBotNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const bot of ownedBots) map.set(bot.id, bot.name);
    if (me?.currentBot?.id && me.currentBot.name) map.set(me.currentBot.id, me.currentBot.name);
    return map;
  }, [ownedBots, me?.currentBot?.id, me?.currentBot?.name]);

  const myTaskOptions = useMemo(
    () => tasks
      .filter((task) => ownedBotIds.has(task.fromBotId) || (task.toBotId ? ownedBotIds.has(task.toBotId) : false))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tasks, ownedBotIds],
  );

  const myDelegatorTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of tasks) {
      if (ownedBotIds.has(task.fromBotId)) ids.add(task.id);
    }
    return ids;
  }, [tasks, ownedBotIds]);

  useEffect(() => {
    if (!selectedBotId && me?.currentBot?.id) {
      setSelectedBotId(me.currentBot.id);
    }
  }, [selectedBotId, me?.currentBot?.id]);

  useEffect(() => {
    if (!selectedTaskId && myTaskOptions.length > 0) {
      setSelectedTaskId(myTaskOptions[0].id);
      return;
    }
    if (selectedTaskId && !myTaskOptions.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(myTaskOptions[0]?.id || '');
    }
  }, [myTaskOptions, selectedTaskId]);

  useEffect(() => {
    setFolderStack([]);
  }, [view, selectedBotId, selectedTaskId]);

  const currentParentId = folderStack.length > 0 ? folderStack[folderStack.length - 1].id : null;

  const actingBotId = useMemo(() => {
    if (view === 'private' && selectedBotId) return selectedBotId;
    return me?.currentBot?.id || selectedBotId || '';
  }, [view, selectedBotId, me?.currentBot?.id]);

  const authHeaders = useMemo(() => {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (actingBotId) headers['X-Bot-Id'] = actingBotId;
    return headers;
  }, [apiKey, actingBotId]);

  const isMinePublicNode = useCallback((node: FileNode) => {
    if (node.createdByActorType === 'bot' && node.createdByActorId && ownedBotIds.has(node.createdByActorId)) {
      return true;
    }
    const metadata = (node.metadata || {}) as Record<string, unknown>;
    const taskId = typeof metadata.taskId === 'string' ? metadata.taskId : '';
    if (taskId && myDelegatorTaskIds.has(taskId)) return true;
    const ownerBotId = typeof metadata.ownerBotId === 'string' ? metadata.ownerBotId : '';
    if (ownerBotId && ownedBotIds.has(ownerBotId)) return true;
    return false;
  }, [ownedBotIds, myDelegatorTaskIds]);

  const fetchFiles = useCallback(async () => {
    if (!apiKey) return;
    if (view === 'private' && !selectedBotId) return;
    if (view === 'task' && !selectedTaskId) {
      setItems([]);
      return;
    }

    setLoading(true);
    setErrorText(null);
    try {
      const qs = new URLSearchParams({ limit: '200' });
      if (currentParentId) {
        qs.set('parentId', currentParentId);
      } else if (view === 'private') {
        qs.set('scope', 'bot_private');
        qs.set('scopeRef', selectedBotId);
      } else if (view === 'task') {
        qs.set('scope', 'task');
        qs.set('scopeRef', selectedTaskId);
      } else {
        qs.set('scope', 'team_shared');
      }

      const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.files}?${qs.toString()}`, { headers: authHeaders });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(toErrorMessage(payload, `Failed to load files (${res.status})`));
      }
      const data = payload as ApiSuccess<{ items: FileNode[] }>;
      const rawItems = Array.isArray(data.data?.items) ? data.data.items : [];
      const visible = view === 'public' ? rawItems.filter(isMinePublicNode) : rawItems;
      setItems(visible);
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiKey, view, selectedBotId, selectedTaskId, currentParentId, authHeaders, isMinePublicNode]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const handleUpload = useCallback(async (evt: ChangeEvent<HTMLInputElement>) => {
    const file = evt.target.files?.[0];
    evt.target.value = '';
    if (!file || !apiKey) return;

    let scope: 'bot_private' | 'task' | 'team_shared';
    let scopeRef: string | undefined;
    if (view === 'private') {
      if (!selectedBotId) return;
      scope = 'bot_private';
      scopeRef = selectedBotId;
    } else if (view === 'task') {
      if (!selectedTaskId) return;
      scope = 'task';
      scopeRef = selectedTaskId;
    } else {
      scope = 'team_shared';
    }

    setUploading(true);
    setStatusText(null);
    setErrorText(null);
    try {
      const contentBase64 = await readFileAsBase64(file);
      const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.files}/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          contentBase64,
          scope,
          ...(scopeRef ? { scopeRef } : {}),
          ...(view === 'public' ? { metadata: { ownerBotId: selectedBotId || me?.currentBot?.id || null, visibility: 'public' } } : {}),
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(toErrorMessage(payload, `Upload failed (${res.status})`));
      }
      setStatusText(`Uploaded: ${file.name}`);
      await fetchFiles();
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setUploading(false);
    }
  }, [apiKey, view, selectedBotId, selectedTaskId, authHeaders, fetchFiles, me?.currentBot?.id]);

  const handleDownload = useCallback(async (node: FileNode) => {
    if (!apiKey) return;
    setStatusText(null);
    setErrorText(null);
    try {
      if (node.kind === 'doc') {
        const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.files}/docs/${node.id}/raw`, {
          headers: authHeaders,
        });
        const payload = await res.json();
        if (!res.ok) {
          throw new Error(toErrorMessage(payload, `Doc download failed (${res.status})`));
        }
        const content = (payload as ApiSuccess<{ content: string }>).data?.content || '';
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${node.name}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.files}/download/${node.id}`, {
          headers: authHeaders,
        });
        if (!res.ok) {
          let fallback = `File download failed (${res.status})`;
          try {
            const payload = await res.json();
            fallback = toErrorMessage(payload, fallback);
          } catch {
            // noop
          }
          throw new Error(fallback);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = node.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
      setStatusText(`Downloaded: ${node.name}`);
    } catch (error) {
      setErrorText((error as Error).message);
    }
  }, [apiKey, authHeaders]);

  const handlePublish = useCallback(async (node: FileNode) => {
    if (!apiKey || !selectedTaskId) return;
    setBusyAction({ nodeId: node.id, action: 'publish' });
    setStatusText(null);
    setErrorText(null);
    try {
      const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.files}/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          sourceNodeId: node.id,
          taskId: selectedTaskId,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(toErrorMessage(payload, `Publish failed (${res.status})`));
      }
      setStatusText(`Published to team shared: ${node.name}`);
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }, [apiKey, selectedTaskId, authHeaders]);

  const handleDelete = useCallback(async (node: FileNode) => {
    if (!apiKey) return;
    const confirmed = window.confirm(`Delete "${node.name}"? This operation recursively soft-deletes children.`);
    if (!confirmed) return;

    setBusyAction({ nodeId: node.id, action: 'delete' });
    setStatusText(null);
    setErrorText(null);
    try {
      const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.files}/${node.id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(toErrorMessage(payload, `Delete failed (${res.status})`));
      }
      setStatusText(`Deleted: ${node.name}`);
      await fetchFiles();
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }, [apiKey, authHeaders, fetchFiles]);

  const ownerLabel = useCallback((node: FileNode): string => {
    if (!node.createdByActorId) return node.createdByActorType;
    if (node.createdByActorType === 'bot') {
      const botName = ownedBotNameById.get(node.createdByActorId);
      return botName ? `${botName} (${shortId(node.createdByActorId)})` : `bot:${shortId(node.createdByActorId)}`;
    }
    return `${node.createdByActorType}:${shortId(node.createdByActorId)}`;
  }, [ownedBotNameById]);

  const emptyText = useMemo(() => {
    if (view === 'private') return 'No private files yet.';
    if (view === 'public') return 'No public files found for your bots yet.';
    if (view === 'team') return 'No team shared files yet.';
    return selectedTaskId ? 'No files in this task yet.' : 'Choose a task to view files.';
  }, [view, selectedTaskId]);

  return (
    <div className="max-w-[1900px] mx-auto px-3 sm:px-4 lg:px-6 py-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Cloud Files</h2>
        <p className="text-gray-600 mt-1">
          Unified file space for private bot files, public outputs, team shared assets, and task artifacts.
        </p>
      </div>

      <div className="bg-white rounded-xl p-6 card-gradient h-[calc(100vh-14rem)] flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {viewOrder.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                view === v
                  ? 'border-primary-200 bg-primary-100 text-primary-700'
                  : 'border-gray-200 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {viewLabels[v]}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {view === 'private' && (
            <label className="text-sm text-gray-600 flex items-center gap-2">
              Bot
              <select
                value={selectedBotId}
                onChange={(e) => setSelectedBotId(e.target.value)}
                className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white text-gray-900"
              >
                {ownedBots.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name} ({shortId(bot.id)})
                  </option>
                ))}
              </select>
            </label>
          )}

          {view === 'task' && (
            <label className="text-sm text-gray-600 flex items-center gap-2">
              Task
              <select
                value={selectedTaskId}
                onChange={(e) => setSelectedTaskId(e.target.value)}
                className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white text-gray-900 max-w-[540px]"
              >
                {myTaskOptions.length === 0 && <option value="">No task available</option>}
                {myTaskOptions.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title || task.prompt?.slice(0, 80) || task.id} ({shortId(task.id)})
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => fetchFiles()}
              disabled={loading || !apiKey}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Refresh
            </button>
            <label className={`px-3 py-1.5 text-xs font-medium rounded-lg border border-primary-200 text-primary-700 ${uploading || !apiKey ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-primary-50'}`}>
              {uploading ? 'Uploading...' : 'Upload File'}
              <input
                type="file"
                className="hidden"
                onChange={handleUpload}
                disabled={uploading || !apiKey}
              />
            </label>
          </div>
        </div>

        {!apiKey && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-2">
            Login with API key to use Cloud Files.
          </p>
        )}
        {view === 'public' && (
          <p className="text-xs text-gray-500">
            Showing team shared files created by your bots or published from your delegator tasks (best-effort ownership mapping).
          </p>
        )}
        {errorText && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg p-2">{errorText}</p>
        )}
        {statusText && (
          <p className="text-xs text-green-700 bg-green-50 border border-green-100 rounded-lg p-2">{statusText}</p>
        )}

        <div className="flex items-center justify-between text-xs text-gray-500">
          <div className="flex items-center gap-2">
            <span>Path:</span>
            <span className="font-medium text-gray-700">{viewLabels[view]}</span>
            {folderStack.map((crumb) => (
              <span key={crumb.id} className="text-gray-500">/ {crumb.name}</span>
            ))}
          </div>
          <button
            type="button"
            disabled={folderStack.length === 0}
            onClick={() => setFolderStack((prev) => prev.slice(0, -1))}
            className="px-2 py-1 rounded border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Up
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto border border-gray-100 rounded-lg">
          {loading ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-500">Loading files...</div>
          ) : items.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-500">{emptyText}</div>
          ) : (
            <table className="min-w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="py-2 px-3">Name</th>
                  <th className="py-2 px-3">Kind</th>
                  <th className="py-2 px-3">Scope</th>
                  <th className="py-2 px-3">Size</th>
                  <th className="py-2 px-3">Owner</th>
                  <th className="py-2 px-3">Updated</th>
                  <th className="py-2 px-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((node) => (
                  <tr key={node.id} className="border-b border-gray-100 last:border-b-0">
                    <td className="py-2 px-3 font-medium text-gray-900">{node.name}</td>
                    <td className="py-2 px-3 text-gray-600">{node.kind}</td>
                    <td className="py-2 px-3 text-gray-600">
                      {node.scope}
                      {node.scopeRef ? ` (${shortId(node.scopeRef)})` : ''}
                    </td>
                    <td className="py-2 px-3 text-gray-600">{formatSize(node.sizeBytes)}</td>
                    <td className="py-2 px-3 text-gray-600">{ownerLabel(node)}</td>
                    <td className="py-2 px-3 text-gray-600">{formatDate(node.updatedAt)}</td>
                    <td className="py-2 px-3">
                      <div className="flex flex-wrap gap-1">
                        {node.kind === 'folder' && (
                          <button
                            type="button"
                            onClick={() => setFolderStack((prev) => [...prev, { id: node.id, name: node.name }])}
                            className="px-2 py-1 rounded border border-gray-200 text-gray-700 hover:bg-gray-50"
                          >
                            Open
                          </button>
                        )}
                        {(node.kind === 'file' || node.kind === 'doc') && (
                          <button
                            type="button"
                            onClick={() => void handleDownload(node)}
                            className="px-2 py-1 rounded border border-gray-200 text-gray-700 hover:bg-gray-50"
                          >
                            Download
                          </button>
                        )}
                        {view === 'task' && node.kind !== 'folder' && (
                          <button
                            type="button"
                            disabled={!!busyAction}
                            onClick={() => void handlePublish(node)}
                            className="px-2 py-1 rounded border border-indigo-200 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                          >
                            {busyAction?.nodeId === node.id && busyAction.action === 'publish' ? 'Publishing...' : 'Publish'}
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={!!busyAction}
                          onClick={() => void handleDelete(node)}
                          className="px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          {busyAction?.nodeId === node.id && busyAction.action === 'delete' ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
