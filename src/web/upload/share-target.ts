// Picks up files stashed by the service worker's Web Share Target and queues them for upload.
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('zk-share-target', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files', { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function takeSharedFiles(): Promise<File[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    const all = store.getAll();
    all.onsuccess = () => {
      store.clear();
      resolve((all.result as File[]).filter((f) => f instanceof Blob));
    };
    tx.onerror = () => reject(tx.error);
  });
}

export const toTargets = (files: File[], parentId: string) =>
  files.map((file) => ({ file, parentId }));
