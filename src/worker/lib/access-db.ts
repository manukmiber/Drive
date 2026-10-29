// The access database (ADR-064 R0 no. 1): share links (R5, ADR-079) and, from R6, sessions, API
// tokens and OAuth, in a D1 of their own (`zeiko-access`, binding ACCESS_DB, migrations in
// `migrations-access/`), apart from the file tree and from Zeiko S3. Until the owner makes that
// database the binding is absent and the same tables in the main D1 answer; code never joins them
// with `nodes` or `users`, so it works either way.
export function accessDb(env: { ACCESS_DB?: D1Database; DB: D1Database }): D1Database {
  return env.ACCESS_DB ?? env.DB;
}

/** Binds a list for `IN (SELECT value FROM json_each(?n))`, in slices that fit one parameter. */
export function idSlices(ids: readonly string[], size = 1000): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(JSON.stringify(ids.slice(i, i + size)));
  return out;
}
