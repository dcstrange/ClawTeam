import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/config';
import { useIdentity } from '@/lib/identity';
import { useTasks } from '@/hooks/useTasks';
import type { FileNode } from '@/lib/types';
import { buildZipManifestEntries, downloadFileNode, downloadFileNodesAsZip } from '@/lib/file-download';
import { formatDate } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { ConfirmModal } from '@/components/ConfirmModal';

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
  const { tr, term } = useI18n();
  const { apiKey, me } = useIdentity();
  const { data: tasks = [] } = useTasks();

  const [view, setView] = useState<CloudFileView>('private');
  const [selectedBotId, setSelectedBotId] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [folderStack, setFolderStack] = useState<FolderCrumb[]>([]);
  const [items, setItems] = useState<FileNode[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [batchDownloading, setBatchDownloading] = useState(false);
  const [isZipPreviewOpen, setIsZipPreviewOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<{ nodeId: string; action: 'publish' | 'delete' } | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const viewLabels: Record<CloudFileView, string> = {
    private: tr('我的私有', 'My Private'),
    public: tr('我的公开', 'My Public'),
    team: tr('团队共享', 'Team Shared'),
    task: tr(`${term('task')}文件`, `${term('task')} Files`),
  };

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

  useEffect(() => {
    setSelectedNodeIds([]);
  }, [view, selectedBotId, selectedTaskId, folderStack]);

  useEffect(() => {
    setSelectedNodeIds((prev) => prev.filter((id) => items.some((node) => node.id === id && (node.kind === 'file' || node.kind === 'doc'))));
  }, [items]);

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
        throw new Error(toErrorMessage(payload, tr(`加载文件失败 (${res.status})`, `Failed to load files (${res.status})`)));
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
  }, [apiKey, view, selectedBotId, selectedTaskId, currentParentId, authHeaders, isMinePublicNode, tr]);

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
        throw new Error(toErrorMessage(payload, tr(`上传失败 (${res.status})`, `Upload failed (${res.status})`)));
      }
      setStatusText(tr(`已上传: ${file.name}`, `Uploaded: ${file.name}`));
      await fetchFiles();
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setUploading(false);
    }
  }, [apiKey, view, selectedBotId, selectedTaskId, authHeaders, fetchFiles, me?.currentBot?.id, tr]);

  const handleDownload = useCallback(async (node: FileNode) => {
    if (!apiKey) return;
    setStatusText(null);
    setErrorText(null);
    try {
      await downloadFileNode(node, authHeaders);
      setStatusText(tr(`已下载: ${node.name}`, `Downloaded: ${node.name}`));
    } catch (error) {
      setErrorText((error as Error).message);
    }
  }, [apiKey, authHeaders, tr]);

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
    setStatusText(null);
    setErrorText(null);
    try {
      const result = await downloadFileNodesAsZip(selectedDownloadableItems, authHeaders, {
        zipName: `cloud-files-${new Date().toISOString().slice(0, 10)}.zip`,
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
      setErrorText((error as Error).message);
    } finally {
      setBatchDownloading(false);
    }
  }, [apiKey, selectedDownloadableItems, authHeaders, tr]);

  const openZipPreview = useCallback(() => {
    if (selectedDownloadableItems.length === 0) return;
    setIsZipPreviewOpen(true);
  }, [selectedDownloadableItems.length]);

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
        throw new Error(toErrorMessage(payload, tr(`发布失败 (${res.status})`, `Publish failed (${res.status})`)));
      }
      setStatusText(tr(`已发布到团队共享: ${node.name}`, `Published to team shared: ${node.name}`));
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }, [apiKey, selectedTaskId, authHeaders, tr]);

  const handleDelete = useCallback(async (node: FileNode) => {
    if (!apiKey) return;
    const confirmed = window.confirm(tr(`确认删除“${node.name}”？该操作会递归软删除子节点。`, `Delete "${node.name}"? This recursively soft-deletes child nodes.`));
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
        throw new Error(toErrorMessage(payload, tr(`删除失败 (${res.status})`, `Delete failed (${res.status})`)));
      }
      setStatusText(tr(`已删除: ${node.name}`, `Deleted: ${node.name}`));
      await fetchFiles();
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }, [apiKey, authHeaders, fetchFiles, tr]);

  const ownerLabel = useCallback((node: FileNode): string => {
    if (!node.createdByActorId) return node.createdByActorType;
    if (node.createdByActorType === 'bot') {
      const botName = ownedBotNameById.get(node.createdByActorId);
      return botName ? `${botName} (${shortId(node.createdByActorId)})` : `${term('bot')}:${shortId(node.createdByActorId)}`;
    }
    return `${node.createdByActorType}:${shortId(node.createdByActorId)}`;
  }, [ownedBotNameById, term]);

  const emptyText = useMemo(() => {
    if (view === 'private') return tr('暂无私有文件。', 'No private files.');
    if (view === 'public') return tr(`暂无与你${term('bot')}关联的公开文件。`, `No public files linked to your ${term('bot')}.`);
    if (view === 'team') return tr('暂无团队共享文件。', 'No team shared files.');
    return selectedTaskId ? tr(`该${term('task')}下暂无文件。`, `No files under this ${term('task')}.`) : tr(`请选择${term('task')}后查看文件。`, `Select a ${term('task')} to view files.`);
  }, [view, selectedTaskId, tr, term]);

  return (
    <>
      <div className="max-w-[1900px] mx-auto px-3 sm:px-4 lg:px-6 py-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">{tr('云端文件', 'Cloud Files')}</h2>
        <p className="text-gray-600 mt-1">
          {tr(`统一管理${term('bot')}私有文件、公开产出、团队共享资产与任务产物。`, `Manage ${term('bot')} private files, public outputs, team shared assets, and ${term('task')} artifacts in one place.`)}
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
              {term('bot')}
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
              {term('task')}
              <select
                value={selectedTaskId}
                onChange={(e) => setSelectedTaskId(e.target.value)}
                className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white text-gray-900 max-w-[540px]"
              >
                {myTaskOptions.length === 0 && <option value="">{tr(`暂无可用${term('task')}`, `No ${term('task')} available`)}</option>}
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
              onClick={() => fetchFiles()}
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
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-2">
            {tr('使用云端文件前请先使用 API Key 登录。', 'Sign in with API key before using cloud files.')}
          </p>
        )}
        {view === 'public' && (
          <p className="text-xs text-gray-500">
            {tr(`仅显示由你名下${term('bot')}创建，或由你委托${term('task')}发布的团队共享文件（尽力做归属映射）。`, `Only shows team shared files created by your ${term('bot')}s or published from ${term('task')}s you delegated.`)}
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
            <span>{tr('路径', 'Path')}:</span>
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
            {tr('返回上级', 'Up one level')}
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto border border-gray-100 rounded-lg">
          {loading ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-500">{tr('文件加载中...', 'Loading files...')}</div>
          ) : items.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-500">{emptyText}</div>
          ) : (
            <table className="min-w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="py-2 px-3">
                    <input
                      type="checkbox"
                      checked={allDownloadableSelected}
                      disabled={downloadableItems.length === 0}
                      onChange={toggleSelectAllDownloadable}
                      className="h-3.5 w-3.5 rounded border-gray-300"
                      aria-label={tr('全选可下载文件', 'Select all downloadable files')}
                    />
                  </th>
                  <th className="py-2 px-3">{tr('名称', 'Name')}</th>
                  <th className="py-2 px-3">{tr('类型', 'Type')}</th>
                  <th className="py-2 px-3">{tr('范围', 'Scope')}</th>
                  <th className="py-2 px-3">{tr('大小', 'Size')}</th>
                  <th className="py-2 px-3">{tr('所有者', 'Owner')}</th>
                  <th className="py-2 px-3">{tr('更新时间', 'Updated')}</th>
                  <th className="py-2 px-3">{tr('操作', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((node) => (
                  <tr key={node.id} className="border-b border-gray-100 last:border-b-0">
                    <td className="py-2 px-3">
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
                            {tr('打开', 'Open')}
                          </button>
                        )}
                        {(node.kind === 'file' || node.kind === 'doc') && (
                          <button
                            type="button"
                          onClick={() => void handleDownload(node)}
                          className="px-2 py-1 rounded border border-gray-200 text-gray-700 hover:bg-gray-50"
                        >
                            {tr('下载', 'Download')}
                          </button>
                        )}
                        {view === 'task' && node.kind !== 'folder' && (
                          <button
                            type="button"
                            disabled={!!busyAction}
                            onClick={() => void handlePublish(node)}
                            className="px-2 py-1 rounded border border-indigo-200 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                          >
                            {busyAction?.nodeId === node.id && busyAction.action === 'publish' ? tr('发布中...', 'Publishing...') : tr('发布', 'Publish')}
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={!!busyAction}
                          onClick={() => void handleDelete(node)}
                          className="px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          {busyAction?.nodeId === node.id && busyAction.action === 'delete' ? tr('删除中...', 'Deleting...') : tr('删除', 'Delete')}
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
