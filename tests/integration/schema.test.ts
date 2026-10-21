import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../../src/worker/db/schema';
import { makeRuntime } from '../helpers/runtime';

describe('schema', () => {
  it('drizzle tables match the SQL migrations column-for-column', async () => {
    const rt = await makeRuntime();
    const tables = Object.values(schema).filter((v) => is(v, SQLiteTable)) as SQLiteTable[];
    expect(tables.length).toBeGreaterThan(40);
    for (const table of tables) {
      const name = getTableName(table);
      const sqlCols = (
        rt.d1.sqlite.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>
      )
        .map((c) => c.name)
        .sort();
      const drizzleCols = Object.values(getTableColumns(table))
        .map((c) => c.name)
        .sort();
      expect(sqlCols, `table ${name}`).toEqual(drizzleCols);
    }
  });

  it('seeds the catalog from Lampiran A', async () => {
    const rt = await makeRuntime();
    const plans = rt.d1.sqlite
      .prepare('SELECT code, price_idr, storage_bytes FROM plans WHERE active = 1 ORDER BY sort')
      .all();
    expect(plans).toEqual([
      { code: 'mini', price_idr: 1000, storage_bytes: 3 * 2 ** 30 },
      { code: 'basic', price_idr: 5000, storage_bytes: 20 * 2 ** 30 },
      { code: 'plus', price_idr: 25000, storage_bytes: 120 * 2 ** 30 },
      { code: 'pro', price_idr: 50000, storage_bytes: 250 * 2 ** 30 },
      { code: 'max', price_idr: 100000, storage_bytes: 600 * 2 ** 30 },
    ]);
  });

  it('keeps FTS5 in sync with node names', async () => {
    const rt = await makeRuntime();
    const db = rt.d1.sqlite;
    db.exec(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'a@b.c', 0, 0)`);
    db.exec(
      `INSERT INTO storage_pools (id, owner_type, owner_id, updated_at) VALUES ('p1', 'user', 'u1', 0)`,
    );
    db.exec(`INSERT INTO nodes (id, pool_id, space, owner_id, created_by, kind, name, name_key, created_at, updated_at)
             VALUES ('n1', 'p1', 'personal', 'u1', 'u1', 'file', 'Laporan_Keuangan-2024.pdf', 'laporan_keuangan-2024.pdf', 0, 0)`);
    const q = (term: string) =>
      db
        .prepare(
          `SELECT n.id FROM nodes_fts f JOIN nodes n ON n.rid = f.rowid WHERE nodes_fts MATCH ?`,
        )
        .all(term);
    expect(q('keuang*')).toEqual([{ id: 'n1' }]);
    db.exec(`UPDATE nodes SET name = 'Foto Liburan.jpg' WHERE id = 'n1'`);
    expect(q('keuang*')).toEqual([]);
    expect(q('libur*')).toEqual([{ id: 'n1' }]);
    db.exec(`DELETE FROM nodes WHERE id = 'n1'`);
    expect(q('libur*')).toEqual([]);
  });

  it('enforces sibling name uniqueness except in the trash', async () => {
    const rt = await makeRuntime();
    const db = rt.d1.sqlite;
    db.exec(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'a@b.c', 0, 0)`);
    db.exec(
      `INSERT INTO storage_pools (id, owner_type, owner_id, updated_at) VALUES ('p1', 'user', 'u1', 0)`,
    );
    const ins = (id: string, trashed: number | null) =>
      db
        .prepare(
          `INSERT INTO nodes (id, pool_id, space, owner_id, created_by, parent_id, kind, name, name_key, trashed_at, created_at, updated_at)
           VALUES (?, 'p1', 'personal', 'u1', 'u1', NULL, 'folder', 'A', 'a', ?, 0, 0)`,
        )
        .run(id, trashed);
    db.exec(`INSERT INTO nodes (id, pool_id, space, owner_id, created_by, kind, name, name_key, created_at, updated_at)
             VALUES ('root', 'p1', 'personal', 'u1', 'u1', 'folder', 'Drive Saya', 'drive saya', 0, 0)`);
    const child = (id: string, key: string, trashed: number | null) =>
      db
        .prepare(
          `INSERT INTO nodes (id, pool_id, space, owner_id, created_by, parent_id, kind, name, name_key, trashed_at, created_at, updated_at)
           VALUES (?, 'p1', 'personal', 'u1', 'u1', 'root', 'file', ?, ?, ?, 0, 0)`,
        )
        .run(id, key, key.toLowerCase(), trashed);
    child('c1', 'Foto.jpg', null);
    expect(() => child('c2', 'FOTO.JPG', null)).toThrow(/UNIQUE/);
    child('c3', 'foto.jpg', 123);
    // A second personal root for the same owner is rejected.
    expect(() => ins('root2', null)).toThrow(/UNIQUE/);
  });
});
