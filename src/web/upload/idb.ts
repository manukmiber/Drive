// Resume records in IndexedDB (SPEC §5.2): { uploadId, fingerprint, parentId }.
const DB_NAME = 'zeiko-uploads';
const STORE = 'resume';

export interface ResumeRecord {
  fingerprint: string;
  uploadId: string;
  parentId: string;
  name: string;
  size: number;
  createdAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'fingerprint' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  try {
    const db = await open();
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null; // private mode / blocked storage: resume simply isn't offered
  }
}

export function fingerprint(file: File, parentId: string): string {
  return `${parentId}|${file.name}|${file.size}|${file.lastModified}`;
}

export const getResume = (fp: string) => tx<ResumeRecord | undefined>('readonly', (s) => s.get(fp));
export const putResume = (r: ResumeRecord) => tx('readwrite', (s) => s.put(r));
export const deleteResume = (fp: string) => tx('readwrite', (s) => s.delete(fp));
