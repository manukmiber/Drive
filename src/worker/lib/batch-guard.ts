// A condition that must hold for a whole D1 batch (ADR-056). D1 has no interactive transactions,
// so a check made before the batch can be stale by the time it runs; this statement re-checks it
// inside the batch and, when it no longer holds, inserts a row the `batch_guards` CHECK refuses,
// which rolls the whole batch back.

/** `cond` is an SQL boolean expression; its `?N` placeholders take `binds` in order. */
export function guardStmt(db: D1Database, cond: string, ...binds: unknown[]): D1PreparedStatement {
  return db.prepare(`INSERT INTO batch_guards (ok) SELECT 0 WHERE NOT (${cond})`).bind(...binds);
}

/** True when a batch failed because a guard did not hold. */
export function isGuardFailure(e: unknown): boolean {
  return /CHECK constraint failed: ok = 1|batch_guards/i.test(String(e));
}
