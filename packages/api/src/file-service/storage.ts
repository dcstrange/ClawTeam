import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

const DEFAULT_STORAGE_DIR = '/tmp/clawteam-file-service';

export interface StoredBlob {
  storageProvider: 'local';
  storageKey: string;
  sizeBytes: number;
  checksumSha256: string;
}

function getStorageRoot(): string {
  const configured = process.env.CLAWTEAM_FILE_STORAGE_DIR?.trim();
  return configured || DEFAULT_STORAGE_DIR;
}

function resolveAbsolutePath(storageKey: string): string {
  if (!storageKey || path.isAbsolute(storageKey) || storageKey.includes('..')) {
    throw new Error('Invalid storage key');
  }
  return path.join(getStorageRoot(), storageKey);
}

export async function saveBuffer(buffer: Buffer): Promise<StoredBlob> {
  const root = getStorageRoot();
  await fs.mkdir(root, { recursive: true });

  const id = randomUUID();
  const shard = id.slice(0, 2);
  const dir = path.join(root, shard);
  await fs.mkdir(dir, { recursive: true });

  const storageKey = `${shard}/${id}.bin`;
  const absolutePath = resolveAbsolutePath(storageKey);
  await fs.writeFile(absolutePath, buffer);

  const checksumSha256 = createHash('sha256').update(buffer).digest('hex');

  return {
    storageProvider: 'local',
    storageKey,
    sizeBytes: buffer.byteLength,
    checksumSha256,
  };
}

export async function readBuffer(storageKey: string): Promise<Buffer> {
  const absolutePath = resolveAbsolutePath(storageKey);
  return fs.readFile(absolutePath);
}

export async function deleteBuffer(storageKey: string): Promise<void> {
  const absolutePath = resolveAbsolutePath(storageKey);
  await fs.unlink(absolutePath);
}
