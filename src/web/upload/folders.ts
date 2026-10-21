// Folder uploads (drag-drop folders and <input webkitdirectory>): create the folder tree first,
// then queue the files (SPEC §5.2).
import { createFolder } from '../lib/files';

export interface PickedFile {
  file: File;
  /** Folder path segments relative to the drop target, e.g. ["Liburan", "Hari 1"]. */
  dirs: string[];
}

export function fromInput(files: FileList | File[]): PickedFile[] {
  return Array.from(files).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    const parts = rel ? rel.split('/') : [file.name];
    return { file, dirs: parts.slice(0, -1) };
  });
}

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(out);
        out.push(...batch);
        next();
      }, reject);
    next();
  });
}

async function walk(entry: FileSystemEntry, dirs: string[], out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) =>
      (entry as FileSystemFileEntry).file(res, rej),
    );
    out.push({ file, dirs });
  } else if (entry.isDirectory) {
    const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
    for (const c of children) await walk(c, [...dirs, entry.name], out);
  }
}

export async function fromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const entries = Array.from(dt.items)
    .map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => Boolean(e));
  if (!entries.length) return fromInput(dt.files);
  const out: PickedFile[] = [];
  for (const e of entries) await walk(e, [], out);
  return out;
}

/** Creates (or reuses) every folder path and returns the target folder id per file. */
export async function resolveTargets(
  rootId: string,
  picked: PickedFile[],
): Promise<Array<{ file: File; parentId: string }>> {
  const cache = new Map<string, string>([['', rootId]]);
  const ensure = async (dirs: string[]): Promise<string> => {
    const key = dirs.join('/');
    const hit = cache.get(key);
    if (hit) return hit;
    const parent = await ensure(dirs.slice(0, -1));
    const { node } = await createFolder(parent, dirs[dirs.length - 1]!, 'reuse');
    cache.set(key, node.id);
    return node.id;
  };
  const out: Array<{ file: File; parentId: string }> = [];
  for (const p of picked) out.push({ file: p.file, parentId: await ensure(p.dirs) });
  return out;
}
