import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/config';
import { useIdentity } from '@/lib/identity';
import type { FileNode } from '@/lib/types';
import { formatDate } from '@/lib/utils';

interface TaskFilesPanelProps {
  taskId: string;
  fallbackBotId?: string;
}

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

export function TaskFilesPanel({ taskId, fallbackBotId }: TaskFilesPanelProps) {
  const { apiKey, me } = useIdentity();
  const [items, setItems] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyAction, setBusyAction] = useState<{ nodeId: string; action: 'move' | 'copy' | 'delete' } | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const actingBotId = me?.currentBot?.id || fallbackBotId || '';

  const authHeaders = useMemo(() => {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    if (actingBotId) {
      headers['X-Bot-Id'] = actingBotId;
    }
    return headers;
  }, [apiKey, actingBotId]);

  const fetchTaskFiles = useCallback(async () => {
    if (!apiKey) return;
    setLoading(true);
    setErrorText(null);
    try {
      const qs = new URLSearchParams({
        scope: 'task',
        scopeRef: taskId,
        limit: '200',
      });
      const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.files}?${qs.toString()}`, {
        headers: authHeaders,
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(toErrorMessage(payload, `Failed to load files (${res.status})`));
      }
      const data = payload as ApiSuccess<{ items: FileNode[] }>;
      setItems(Array.isArray(data.data?.items) ? data.data.items : []);
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiKey, authHeaders, taskId]);

  useEffect(() => {
    fetchTaskFiles();
  }, [fetchTaskFiles]);

  const handleUpload = useCallback(async (evt: React.ChangeEvent<HTMLInputElement>) => {
    const file = evt.target.files?.[0];
    evt.target.value = '';
    if (!file || !apiKey) return;

    setUploading(true);
    setErrorText(null);
    setStatusText(null);
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
          scope: 'task',
          scopeRef: taskId,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(toErrorMessage(payload, `Upload failed (${res.status})`));
      }
      setStatusText(`Uploaded: ${file.name}`);
      await fetchTaskFiles();
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setUploading(false);
    }
  }, [apiKey, authHeaders, fetchTaskFiles, taskId]);

  const handleDownload = useCallback(async (node: FileNode) => {
    if (!apiKey) return;
    setErrorText(null);
    setStatusText(null);
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
    if (!apiKey) return;
    setErrorText(null);
    setStatusText(null);
    try {
      const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.files}/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          sourceNodeId: node.id,
          taskId,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(toErrorMessage(payload, `Publish failed (${res.status})`));
      }
      setStatusText(`Published to team_shared: ${node.name}`);
    } catch (error) {
      setErrorText((error as Error).message);
    }
  }, [apiKey, authHeaders, taskId]);

  const handleMove = useCallback(async (node: FileNode) => {
    if (!apiKey) return;
    const targetParentInput = window.prompt(
      'Target folder node ID (leave empty to move to task root)',
      node.parentId || '',
    );
    if (targetParentInput === null) return;
    const newNameInput = window.prompt('New name (leave empty to keep current)', node.name);
    if (newNameInput === null) return;

    const body: Record<string, string> = {
      nodeId: node.id,
      taskId,
    };
    const normalizedTarget = targetParentInput.trim();
    const normalizedName = newNameInput.trim();
    if (normalizedTarget) body.targetParentId = normalizedTarget;
    if (normalizedName && normalizedName !== node.name) body.newName = normalizedName;
    if (!normalizedTarget && !body.newName && node.parentId === null) {
      setStatusText('No move changes submitted.');
      return;
    }

    setBusyAction({ nodeId: node.id, action: 'move' });
    setErrorText(null);
    setStatusText(null);
    try {
      const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.files}/move`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(toErrorMessage(payload, `Move failed (${res.status})`));
      }
      setStatusText(`Moved: ${node.name}`);
      await fetchTaskFiles();
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }, [apiKey, authHeaders, fetchTaskFiles, taskId]);

  const handleCopy = useCallback(async (node: FileNode) => {
    if (!apiKey) return;
    const targetParentInput = window.prompt(
      'Target folder node ID for copy (leave empty to copy into task root)',
      node.parentId || '',
    );
    if (targetParentInput === null) return;
    const suggestedName = `${node.name}-copy`;
    const newNameInput = window.prompt('Name for copied node (leave empty to auto-name)', suggestedName);
    if (newNameInput === null) return;

    const body: Record<string, string> = {
      sourceNodeId: node.id,
      taskId,
    };
    const normalizedTarget = targetParentInput.trim();
    const normalizedName = newNameInput.trim();
    if (normalizedTarget) body.targetParentId = normalizedTarget;
    if (normalizedName) body.newName = normalizedName;

    setBusyAction({ nodeId: node.id, action: 'copy' });
    setErrorText(null);
    setStatusText(null);
    try {
      const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.files}/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(toErrorMessage(payload, `Copy failed (${res.status})`));
      }
      setStatusText(`Copied: ${node.name}`);
      await fetchTaskFiles();
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }, [apiKey, authHeaders, fetchTaskFiles, taskId]);

  const handleDelete = useCallback(async (node: FileNode) => {
    if (!apiKey) return;
    const confirmed = window.confirm(`Delete "${node.name}"? This operation recursively soft-deletes children.`);
    if (!confirmed) return;

    setBusyAction({ nodeId: node.id, action: 'delete' });
    setErrorText(null);
    setStatusText(null);
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
      await fetchTaskFiles();
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }, [apiKey, authHeaders, fetchTaskFiles]);

  return (
    <div className="bg-white rounded-xl p-6 card-gradient">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">Task Files</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fetchTaskFiles()}
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
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-2 mb-3">
          Login with API key to manage task files.
        </p>
      )}
      {errorText && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg p-2 mb-3">{errorText}</p>
      )}
      {statusText && (
        <p className="text-xs text-green-700 bg-green-50 border border-green-100 rounded-lg p-2 mb-3">{statusText}</p>
      )}

      {loading ? (
        <div className="text-xs text-gray-500">Loading files...</div>
      ) : items.length === 0 ? (
        <div className="text-xs text-gray-500">No task files yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="py-2 pr-2">Name</th>
                <th className="py-2 pr-2">Kind</th>
                <th className="py-2 pr-2">Size</th>
                <th className="py-2 pr-2">Updated</th>
                <th className="py-2 pr-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((node) => (
                <tr key={node.id} className="border-b border-gray-100 last:border-b-0">
                  <td className="py-2 pr-2 font-medium text-gray-900">{node.name}</td>
                  <td className="py-2 pr-2 text-gray-600">{node.kind}</td>
                  <td className="py-2 pr-2 text-gray-600">{formatSize(node.sizeBytes)}</td>
                  <td className="py-2 pr-2 text-gray-600">{formatDate(node.updatedAt)}</td>
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-2">
                      {(node.kind === 'file' || node.kind === 'doc') && (
                        <button
                          type="button"
                          onClick={() => handleDownload(node)}
                          disabled={!!busyAction}
                          className="text-primary-700 hover:underline"
                        >
                          Download
                        </button>
                      )}
                      {node.kind !== 'folder' && (
                        <button
                          type="button"
                          onClick={() => handlePublish(node)}
                          disabled={!!busyAction}
                          className="text-indigo-700 hover:underline"
                        >
                          Publish
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleMove(node)}
                        disabled={!!busyAction}
                        className="text-gray-700 hover:underline disabled:opacity-50"
                      >
                        {busyAction?.nodeId === node.id && busyAction.action === 'move' ? 'Moving...' : 'Move'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCopy(node)}
                        disabled={!!busyAction}
                        className="text-gray-700 hover:underline disabled:opacity-50"
                      >
                        {busyAction?.nodeId === node.id && busyAction.action === 'copy' ? 'Copying...' : 'Copy'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(node)}
                        disabled={!!busyAction}
                        className="text-red-700 hover:underline disabled:opacity-50"
                      >
                        {busyAction?.nodeId === node.id && busyAction.action === 'delete' ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
