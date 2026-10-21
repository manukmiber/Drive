// Applies migrations/*.sql in order, tracked in `d1_migrations` (same table wrangler uses).
import type { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

export function applyMigrations(db: DatabaseSync, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
  const done = new Set(
    (db.prepare('SELECT name FROM d1_migrations').all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(e as Error).message}`, { cause: e });
    }
    applied.push(file);
  }
  return applied;
}
