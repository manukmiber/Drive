// Verifies archives with Python's zipfile (independent implementation): returns {name: text}.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function readZip(bytes: Uint8Array): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'zk-zip-'));
  const file = join(dir, 'a.zip');
  writeFileSync(file, bytes);
  const py = `import zipfile,json,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps({i.filename:(z.read(i).decode('utf-8','replace') if not i.is_dir() else None) for i in z.infolist()}))`;
  const r = spawnSync('python3', ['-I', '-c', py, file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`invalid zip: ${r.stderr}`);
  return JSON.parse(r.stdout) as Record<string, string>;
}
