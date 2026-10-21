import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';

export type Db = DrizzleD1Database<typeof schema>;

const cache = new WeakMap<D1Database, Db>();

export function getDb(d1: D1Database): Db {
  let db = cache.get(d1);
  if (!db) {
    db = drizzle(d1, { schema });
    cache.set(d1, db);
  }
  return db;
}

export { schema };
