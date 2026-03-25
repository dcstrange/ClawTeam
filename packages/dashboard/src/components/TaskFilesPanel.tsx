import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/config';
import { useIdentity } from '@/lib/identity';
import type { FileNode } from '@/lib/types';
import { buildZipManifestEntries, downloadFileNode, downloadFileNodesAsZip } from '@/lib/file-download';
import { formatDate } from '@/lib/utils';
import { useI18n, trGlobal as trG, termGlobal as termG } from '@/lib/i18n';
import { ConfirmModal } from './ConfirmModal';

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
    if (p.error?.message) {
      if (p.error.message === 'Actor is not task participant') {
        return trG('你不是该子任务文件域的直接参与者。已批准的子任务产物会镜像到父任务文件中。', 'You are not a direct participant in this sub-task file scope. Approved sub-task outputs are mirrored to parent task files.');
      }
      return p.error.message;
    }
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
  const { tr, term } = useI18n();
  const { apiKey, me } = useIdentity();
  const [items, setItems] = useState<FileNode[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [batchDownloading, setBatchDownloading] = useState(false);
  const [isZipPreviewOpen, setIsZipPreviewOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<{ nodeId: string; action: 'move' | 'copy' | 'delete' } | null>(null);
  const [openMenuNodeId, setOpenMenuNodeId] = useState<string | null>(null);
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

  useEffect(() => {
    setSelectedNodeIds([]);
  }, [taskId]);

  useEffect(() => {
    setSelectedNodeIds((prev) => prev.filter((id) => items.some((node) => node.id === id && (node.kind === 'file' || node.kind === 'doc'))));
  }, [items]);

  useEffect(() => {
    if (!openMenuNodeId) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-file-action-menu-root="true"]')) return;
      setOpenMenuNodeId(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [openMenuNodeId]);

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
        throw new Error(toErrorMessage(payload, tr(`上传失败 (${res.status})`, `Upload failed (${res.status})`)));
      }
      setStatusText(tr(`已上传: ${file.name}`, `Uploaded: ${file.name}`));
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
      await downloadFileNode(node, authHeaders);
      setStatusText(tr(`已下载: ${node.name}`, `Downloaded: ${node.name}`));
    } catch (error) {
      const msg = (error as Error).message;
      setErrorText(toErrorMessage({ error: { message: msg } }, msg));
    }
  }, [apiKey, authHeaders]);

  const downloadableItems = useMemo(
    () => items.filter((node) => node.kind === 'file' || node.kind === 'doc'),
    [items],
  );
  const selectedDownloadableItems = useMemo(() => {
    const selected = new Set(selectedNodeIds);
    return downloadableItems.filter((node) => selected.has(node.id));
  }, [downloadableItems, selectedNodeIds]);
  const zipPreviewEntries = useMemo(
    () => buildZipManifestEntries(selectedDownloadableItems),
    [selectedDownloadableItems],
  );
  const allDownloadableSelected = downloadableItems.length > 0 && selectedDownloadableItems.length === downloadableItems.length;

  const toggleSelectedNode = useCallback((nodeId: string) => {
    setSelectedNodeIds((prev) => (
      prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId]
    ));
  }, []);

  const toggleSelectAllDownloadable = useCallback(() => {
    setSelectedNodeIds((prev) => {
      const prevSet = new Set(prev);
      if (downloadableItems.length > 0 && downloadableItems.every((node) => prevSet.has(node.id))) {
        return prev.filter((id) => !downloadableItems.some((node) => node.id === id));
      }
      const merged = new Set(prev);
      for (const node of downloadableItems) merged.add(node.id);
      return Array.from(merged);
    });
  }, [downloadableItems]);

  const handleBatchDownload = useCallback(async () => {
    if (!apiKey || selectedDownloadableItems.length === 0) return;
    setBatchDownloading(true);
    setErrorText(null);
    setStatusText(null);
    try {
      const result = await downloadFileNodesAsZip(selectedDownloadableItems, authHeaders, {
        zipName: `task-${taskId}-files.zip`,
      });
      if (result.failures.length === 0) {
        setStatusText(tr(
          `ZIP 下载完成，共 ${result.succeeded} 个文件。`,
          `ZIP download complete: ${result.succeeded} files.`,
        ));
      } else {
        const first = result.failures[0];
        const firstReason = toErrorMessage({ error: { message: first.reason } }, first.reason);
        setErrorText(tr(
          `ZIP 下载部分失败：成功 ${result.succeeded}/${result.requested}，首个失败 ${first.name}: ${firstReason}`,
          `ZIP download partially failed: ${result.succeeded}/${result.requested} succeeded. First failure ${first.name}: ${firstReason}`,
        ));
      }
    } catch (error) {
      const msg = (error as Error).message;
      setErrorText(toErrorMessage({ error: { message: msg } }, msg));
    } finally {
      setBatchDownloading(false);
    }
  }, [apiKey, authHeaders, selectedDownloadableItems, tr]);

  const openZipPreview = useCallback(() => {
    if (selectedDownloadableItems.length === 0) return;
    setIsZipPreviewOpen(true);
  }, [selectedDownloadableItems.length]);

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
        throw new Error(toErrorMessage(payload, tr(`发布失败 (${res.status})`, `Publish failed (${res.status})`)));
      }
      setStatusText(tr(`已发布到 team_shared: ${node.name}`, `Published to team_shared: ${node.name}`));
    } catch (error) {
      setErrorText((error as Error).message);
    }
  }, [apiKey, authHeaders, taskId]);

  const handleMove = useCallback(async (node: FileNode) => {
    if (!apiKey) return;
    const targetParentInput = window.prompt(
      tr('目标文件夹节点 ID（留空移动到任务根目录）', `Target folder node ID (leave empty to move to ${term('task')} root)`),
      node.parentId || '',
    );
    if (targetParentInput === null) return;
    const newNameInput = window.prompt(tr('新名称（留空保持当前名称）', 'New name (leave empty to keep current name)'), node.name);
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
      setStatusText(tr('未提交任何移动变更。', 'No move change submitted.'));
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
        throw new Error(toErrorMessage(payload, tr(`移动失败 (${res.status})`, `Move failed (${res.status})`)));
      }
      setStatusText(tr(`已移动: ${node.name}`, `Moved: ${node.name}`));
      await fetchTaskFiles();
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }, [apiKey, authHeaders, fetchTaskFiles, taskId, tr, term]);

  const handleCopy = useCallback(async (node: FileNode) => {
    if (!apiKey) return;
    const targetParentInput = window.prompt(
      tr('复制目标文件夹节点 ID（留空复制到任务根目录）', `Target folder node ID for copy (leave empty to copy to ${term('task')} root)`),
      node.parentId || '',
    );
    if (targetParentInput === null) return;
    const suggestedName = `${node.name}-copy`;
    const newNameInput = window.prompt(tr('复制后名称（留空自动命名）', 'Name after copy (leave empty for auto name)'), suggestedName);
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
        throw new Error(toErrorMessage(payload, tr(`复制失败 (${res.status})`, `Copy failed (${res.status})`)));
      }
      setStatusText(tr(`已复制: ${node.name}`, `Copied: ${node.name}`));
      await fetchTaskFiles();
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }, [apiKey, authHeaders, fetchTaskFiles, taskId, tr, term]);

  const handleDelete = useCallback(async (node: FileNode) => {
    if (!apiKey) return;
    const confirmed = window.confirm(tr(`确认删除“${node.name}”？该操作会递归软删除子节点。`, `Delete "${node.name}"? This recursively soft-deletes child nodes.`));
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
        throw new Error(toErrorMessage(payload, tr(`删除失败 (${res.status})`, `Delete failed (${res.status})`)));
      }
      setStatusText(tr(`已删除: ${node.name}`, `Deleted: ${node.name}`));
      await fetchTaskFiles();
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }, [apiKey, authHeaders, fetchTaskFiles, tr]);

  return (
    <>
      <div className="bg-white rounded-xl p-6 card-gradient h-[36rem] flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">{tr(`${term('task')}文件`, `${term('task')} Files`)}</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openZipPreview}
            disabled={batchDownloading || selectedDownloadableItems.length === 0 || !apiKey}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-50"
          >
            {batchDownloading
              ? tr('ZIP 打包中...', 'Packaging ZIP...')
              : tr(`下载 ZIP (${selectedDownloadableItems.length})`, `Download ZIP (${selectedDownloadableItems.length})`)}
          </button>
          <button
            type="button"
            onClick={() => fetchTaskFiles()}
            disabled={loading || !apiKey}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {tr('刷新', 'Refresh')}
          </button>
          <label className={`px-3 py-1.5 text-xs font-medium rounded-lg border border-primary-200 text-primary-700 ${uploading || !apiKey ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-primary-50'}`}>
            {uploading ? tr('上传中...', 'Uploading...') : tr('上传文件', 'Upload file')}
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
          {tr(`请先使用 API Key 登录后管理${term('task')}文件。`, `Please sign in with API key before managing ${term('task')} files.`)}
        </p>
      )}
      {errorText && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg p-2 mb-3">{errorText}</p>
      )}
      {statusText && (
        <p className="text-xs text-green-700 bg-green-50 border border-green-100 rounded-lg p-2 mb-3">{statusText}</p>
      )}

      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="text-xs text-gray-500">{tr('文件加载中...', 'Loading files...')}</div>
        ) : items.length === 0 ? (
          <div className="text-xs text-gray-500">{tr(`暂无${term('task')}文件。`, `No ${term('task')} files yet.`)}</div>
        ) : (
          <div className="overflow-auto h-full">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="py-2 pr-2">
                    <input
                      type="checkbox"
                      checked={allDownloadableSelected}
                      disabled={downloadableItems.length === 0}
                      onChange={toggleSelectAllDownloadable}
                      className="h-3.5 w-3.5 rounded border-gray-300"
                      aria-label={tr('全选可下载文件', 'Select all downloadable files')}
                    />
                  </th>
                  <th className="py-2 pr-2">{tr('名称', 'Name')}</th>
                  <th className="py-2 pr-2">{tr('类型', 'Type')}</th>
                  <th className="py-2 pr-2">{tr('大小', 'Size')}</th>
                  <th className="py-2 pr-2">{tr('更新时间', 'Updated')}</th>
                  <th className="py-2 pr-2">{tr('操作', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((node) => (
                  <tr key={node.id} className="border-b border-gray-100 last:border-b-0">
                    <td className="py-2 pr-2">
                      {(node.kind === 'file' || node.kind === 'doc') ? (
                        <input
                          type="checkbox"
                          checked={selectedNodeIds.includes(node.id)}
                          onChange={() => toggleSelectedNode(node.id)}
                          className="h-3.5 w-3.5 rounded border-gray-300"
                          aria-label={tr(`选择文件 ${node.name}`, `Select file ${node.name}`)}
                        />
                      ) : (
                        <span className="text-gray-300">-</span>
                      )}
                    </td>
                    <td className="py-2 pr-2 font-medium text-gray-900">{node.name}</td>
                    <td className="py-2 pr-2 text-gray-600">{node.kind}</td>
                    <td className="py-2 pr-2 text-gray-600">{formatSize(node.sizeBytes)}</td>
                    <td className="py-2 pr-2 text-gray-600">{formatDate(node.updatedAt)}</td>
                    <td className="py-2 pr-2">
                      <div className="relative inline-block text-left" data-file-action-menu-root="true">
                        <button
                          type="button"
                          onClick={() => setOpenMenuNodeId((prev) => (prev === node.id ? null : node.id))}
                          disabled={!!busyAction}
                          className="h-7 w-7 rounded-md border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          aria-label={tr(`打开 ${node.name} 的操作菜单`, `Open action menu for ${node.name}`)}
                        >
                          ...
                        </button>

                        {openMenuNodeId === node.id && (
                          <div className="absolute right-0 z-20 mt-1 w-40 rounded-lg border border-gray-200 glass-popover py-1">
                            {(node.kind === 'file' || node.kind === 'doc') && (
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenMenuNodeId(null);
                                  void handleDownload(node);
                                }}
                                disabled={!!busyAction}
                                className="w-full text-left px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                              >
                                {tr('下载', 'Download')}
                              </button>
                            )}
                            {node.kind !== 'folder' && (
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenMenuNodeId(null);
                                  void handlePublish(node);
                                }}
                                disabled={!!busyAction}
                                className="w-full text-left px-3 py-1.5 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                              >
                                {tr('发布', 'Publish')}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuNodeId(null);
                                void handleMove(node);
                              }}
                              disabled={!!busyAction}
                              className="w-full text-left px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                              >
                              {busyAction?.nodeId === node.id && busyAction.action === 'move' ? tr('移动中...', 'Moving...') : tr('移动', 'Move')}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuNodeId(null);
                                void handleCopy(node);
                              }}
                              disabled={!!busyAction}
                              className="w-full text-left px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                              >
                              {busyAction?.nodeId === node.id && busyAction.action === 'copy' ? tr('复制中...', 'Copying...') : tr('复制', 'Copy')}
                            </button>
                            <div className="my-1 border-t border-gray-100" />
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuNodeId(null);
                                void handleDelete(node);
                              }}
                              disabled={!!busyAction}
                              className="w-full text-left px-3 py-1.5 text-red-700 hover:bg-red-50 disabled:opacity-50"
                            >
                              {busyAction?.nodeId === node.id && busyAction.action === 'delete' ? tr('删除中...', 'Deleting...') : tr('删除', 'Delete')}
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </div>

      <ConfirmModal
        isOpen={isZipPreviewOpen}
        title={tr('下载 ZIP 预览', 'ZIP Download Preview')}
        description={tr(`将打包 ${zipPreviewEntries.length} 个文件，按目录结构写入 ZIP。`, `Will package ${zipPreviewEntries.length} files into ZIP with folder structure.`)}
        confirmLabel={batchDownloading ? tr('打包中...', 'Packaging...') : tr('确认下载 ZIP', 'Download ZIP')}
        onConfirm={() => {
          setIsZipPreviewOpen(false);
          void handleBatchDownload();
        }}
        onCancel={() => setIsZipPreviewOpen(false)}
      >
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-2 max-h-72 overflow-auto">
          {zipPreviewEntries.length === 0 ? (
            <p className="text-xs text-gray-500">{tr('暂无可下载文件。', 'No downloadable files selected.')}</p>
          ) : (
            <div className="space-y-1">
              {zipPreviewEntries.map((entry) => (
                <div key={entry.nodeId} className="flex items-start justify-between gap-2 px-1 py-1 text-xs">
                  <code className="text-gray-700 break-all">{entry.zipPath}</code>
                  {entry.renamed && (
                    <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800">
                      {tr('重名已改名', 'Renamed')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </ConfirmModal>
    </>
  );
}
