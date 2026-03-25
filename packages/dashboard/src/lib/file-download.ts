import { API_BASE_URL, API_ENDPOINTS } from '@/lib/config';
import type { FileNode } from '@/lib/types';
import JSZip from 'jszip';

interface ApiSuccess<T> {
  success: true;
  data: T;
}

interface ApiError {
  success: false;
  error?: {
    message?: string;
  };
}

export interface BatchDownloadFailure {
  nodeId: string;
  name: string;
  reason: string;
}

export interface BatchDownloadResult {
  requested: number;
  succeeded: number;
  failures: BatchDownloadFailure[];
}

export interface DownloadZipOptions {
  zipName?: string;
}

export interface ZipManifestEntry {
  nodeId: string;
  sourceName: string;
  kind: 'file' | 'doc';
  zipPath: string;
  renamed: boolean;
}

type DownloadableFileNode = FileNode & { kind: 'file' | 'doc' };

function isDownloadable(node: FileNode): node is DownloadableFileNode {
  return node.kind === 'file' || node.kind === 'doc';
}

function toErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const p = payload as ApiError;
    if (p.error?.message) return p.error.message;
  }
  return fallback;
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function toMetadataRecord(node: FileNode): Record<string, unknown> {
  if (node.metadata && typeof node.metadata === 'object') {
    return node.metadata as Record<string, unknown>;
  }
  return {};
}

function cleanPathSegment(segment: string): string {
  return segment
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePath(pathLike: string): string {
  const normalized = pathLike.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  const safeParts = normalized
    .split('/')
    .map((part) => cleanPathSegment(part))
    .filter((part) => part && part !== '.' && part !== '..');
  return safeParts.join('/');
}

function splitNameToPath(name: string): { dirs: string[]; fileName: string } {
  const normalized = normalizePath(name);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return { dirs: [], fileName: 'unnamed' };
  return {
    dirs: parts.slice(0, -1),
    fileName: parts[parts.length - 1] || 'unnamed',
  };
}

function getMetadataPathHint(node: FileNode): string {
  const metadata = toMetadataRecord(node);
  const candidates = [
    metadata.relativePath,
    metadata.path,
    metadata.logicalPath,
    metadata.targetPath,
    metadata.filePath,
    metadata.artifactPath,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return normalizePath(candidate);
    }
  }
  return '';
}

function ensureDocFileExtension(name: string): string {
  if (!name) return 'document.txt';
  if (/\.[a-z0-9]+$/i.test(name)) return name;
  return `${name}.txt`;
}

function resolveZipEntryPath(node: FileNode): string {
  const fromName = splitNameToPath(node.name || '');
  const metadataHint = getMetadataPathHint(node);

  let filename = fromName.fileName;
  if (node.kind === 'doc') {
    filename = ensureDocFileExtension(filename);
  }

  // If file name already contains directories, trust it as the primary path source.
  if (fromName.dirs.length > 0) {
    return normalizePath([...fromName.dirs, filename].join('/')) || filename;
  }

  const metadataParts = metadataHint ? metadataHint.split('/').filter(Boolean) : [];
  const metadataTail = metadataParts.length > 0 ? metadataParts[metadataParts.length - 1] : '';
  const metadataLooksLikeFullFilePath = !!metadataTail && /\.[a-z0-9]+$/i.test(metadataTail);
  const pathParts = metadataLooksLikeFullFilePath
    ? metadataParts
    : [...metadataParts, filename];

  return normalizePath(pathParts.join('/')) || filename;
}

function uniqueZipPath(path: string, used: Set<string>): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const lastSlash = path.lastIndexOf('/');
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : '';
  const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  let i = 2;
  while (true) {
    const candidate = `${dir ? `${dir}/` : ''}${base} (${i})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    i += 1;
  }
}

async function fetchFileContent(node: FileNode, authHeaders: Record<string, string>): Promise<Blob> {
  if (node.kind === 'doc') {
    const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.files}/docs/${node.id}/raw`, {
      headers: authHeaders,
    });
    const payload = await res.json();
    if (!res.ok) {
      throw new Error(toErrorMessage(payload, `Document download failed (${res.status})`));
    }
    const content = (payload as ApiSuccess<{ content: string }>).data?.content || '';
    return new Blob([content], { type: 'text/plain;charset=utf-8' });
  }

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
  return res.blob();
}

export async function downloadFileNode(node: FileNode, authHeaders: Record<string, string>): Promise<void> {
  if (!isDownloadable(node)) {
    throw new Error('Only file/doc nodes can be downloaded');
  }

  const blob = await fetchFileContent(node, authHeaders);
  const baseName = splitNameToPath(node.name || '').fileName;
  const downloadName = node.kind === 'doc' ? ensureDocFileExtension(baseName) : baseName;
  triggerBrowserDownload(blob, downloadName);
}

export async function batchDownloadFileNodes(nodes: FileNode[], authHeaders: Record<string, string>): Promise<BatchDownloadResult> {
  const uniqueNodes = Array.from(
    new Map(nodes.filter(isDownloadable).map((node) => [node.id, node])).values(),
  );

  const failures: BatchDownloadFailure[] = [];
  let succeeded = 0;

  for (const node of uniqueNodes) {
    try {
      await downloadFileNode(node, authHeaders);
      succeeded += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
    } catch (error) {
      failures.push({
        nodeId: node.id,
        name: node.name,
        reason: (error as Error).message || 'Unknown error',
      });
    }
  }

  return {
    requested: uniqueNodes.length,
    succeeded,
    failures,
  };
}

export function buildZipManifestEntries(nodes: FileNode[]): ZipManifestEntry[] {
  const uniqueNodes = Array.from(
    new Map(nodes.filter(isDownloadable).map((node) => [node.id, node])).values(),
  );
  const usedPaths = new Set<string>();

  return uniqueNodes.map((node) => {
    const rawPath = resolveZipEntryPath(node);
    const zipPath = uniqueZipPath(rawPath, usedPaths);
    return {
      nodeId: node.id,
      sourceName: node.name,
      kind: node.kind,
      zipPath,
      renamed: zipPath !== rawPath,
    };
  });
}

export async function downloadFileNodesAsZip(
  nodes: FileNode[],
  authHeaders: Record<string, string>,
  options: DownloadZipOptions = {},
): Promise<BatchDownloadResult> {
  const uniqueNodes = Array.from(
    new Map(nodes.filter(isDownloadable).map((node) => [node.id, node])).values(),
  );
  const manifest = buildZipManifestEntries(uniqueNodes);

  const zip = new JSZip();
  const failures: BatchDownloadFailure[] = [];
  let succeeded = 0;
  const byId = new Map(uniqueNodes.map((node) => [node.id, node]));

  for (const entry of manifest) {
    const node = byId.get(entry.nodeId);
    if (!node) continue;
    try {
      const blob = await fetchFileContent(node, authHeaders);
      const bytes = await blob.arrayBuffer();
      zip.file(entry.zipPath, bytes);
      succeeded += 1;
    } catch (error) {
      failures.push({
        nodeId: node.id,
        name: node.name,
        reason: (error as Error).message || 'Unknown error',
      });
    }
  }

  if (succeeded > 0) {
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipName = options.zipName || `clawteam-files-${timestamp}.zip`;
    triggerBrowserDownload(zipBlob, zipName);
  }

  return {
    requested: uniqueNodes.length,
    succeeded,
    failures,
  };
}
