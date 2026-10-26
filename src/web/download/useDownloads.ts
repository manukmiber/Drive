import { useSyncExternalStore } from 'react';
import { api, postJson } from '../lib/api';
import { browserDeps } from './browser';
import { DownloadManager, type DownloadSource, type Sink } from './manager';
import {
  deviceSink,
  deviceSupported,
  folderSink,
  folderSupported,
  pickFolder,
  sweepDevice,
} from './sinks';

let manager: DownloadManager | null = null;

export function initDownloads(maxFiles: number): DownloadManager {
  if (!manager) {
    manager = new DownloadManager({ maxFiles }, browserDeps());
    void sweepDevice();
  }
  return manager;
}

export function downloads(): DownloadManager {
  if (!manager) throw new Error('download manager not initialised');
  return manager;
}

export function useDownloads() {
  const m = downloads();
  return useSyncExternalStore(m.subscribe, m.getSnapshot);
}

export const canSaveToFolder = folderSupported;

interface Plan {
  items: Array<{ nodeId: string; name: string; path: string; size: number; url: string }>;
  folders: string[];
  skipped: number;
  totalBytes: number;
}

export interface QueuedBatch {
  files: number;
  skipped: number;
  totalBytes: number;
  /** The picked folder's name, when saving into one. */
  folder: string | null;
}

/**
 * "Download separately" for Drive items (ADR-053). With `toFolder`, the folder picker opens first
 * (it needs the click), and the batch keeps its folder structure there. Null = the person closed
 * the picker.
 */
export async function queueDriveDownload(
  nodeIds: string[],
  toFolder: boolean,
): Promise<QueuedBatch | null> {
  const m = downloads();
  let sink: Sink | null = null;
  let folder: ReturnType<typeof folderSink> | null = null;
  if (toFolder) {
    const dir = await pickFolder();
    if (!dir) return null;
    folder = folderSink(dir);
    sink = folder;
  } else if (deviceSupported()) {
    sink = deviceSink(browserDeps().handOff);
  }
  const plan = await postJson<Plan>('/api/files/download-plan', { nodeIds });
  if (folder) await folder.ensureFolders(plan.folders);
  const sources: DownloadSource[] = plan.items.map((i) => ({
    name: i.name,
    path: i.path,
    size: i.size,
    url: i.url,
    refresh: async () => (await api<{ url: string }>(`/api/files/${i.nodeId}/download`)).url,
  }));
  if (sources.length) m.add(sources, sink);
  return {
    files: sources.length,
    skipped: plan.skipped,
    totalBytes: plan.totalBytes,
    folder: folder?.name ?? null,
  };
}

/** Any source (S3 objects too): into the Downloads folder, a few at a time. */
export function queueSources(sources: DownloadSource[]): void {
  if (!sources.length) return;
  downloads().add(sources, deviceSupported() ? deviceSink(browserDeps().handOff) : null);
}
