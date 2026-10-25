// The folders of a ZIP, from its file paths (ADR-051). Archives often have no entries for their
// folders, so folders are what the paths go through.
import type { ZipEntry } from './zip';

export const keyOf = (path: string[]) => path.join('/');

export interface ZipFolder {
  name: string;
  files: number;
  size: number;
}

/** What is directly in folder `cwd`: its folders (by name) and its files. */
export function contents(
  entries: ZipEntry[],
  cwd: string[],
): { folders: ZipFolder[]; files: ZipEntry[] } {
  const folders = new Map<string, ZipFolder>();
  const files: ZipEntry[] = [];
  for (const e of entries) {
    if (e.path.length <= cwd.length || !cwd.every((s, i) => e.path[i] === s)) continue;
    if (e.path.length === cwd.length + 1) {
      files.push(e);
      continue;
    }
    const name = e.path[cwd.length]!;
    const f = folders.get(name) ?? { name, files: 0, size: 0 };
    f.files++;
    f.size += e.size;
    folders.set(name, f);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  return {
    folders: [...folders.values()].sort((a, b) => byName(a.name, b.name)),
    files: files.sort((a, b) => byName(a.path.at(-1)!, b.path.at(-1)!)),
  };
}

/** The files at `path`: the file itself, or everything in the folder. */
export function filesUnder(entries: ZipEntry[], path: string[]): ZipEntry[] {
  return entries.filter(
    (e) => e.path.length >= path.length && path.every((s, i) => e.path[i] === s),
  );
}
