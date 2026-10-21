import { defineConfig } from 'drizzle-kit';

// Used only for `drizzle-kit check`/introspection. Migrations are hand-written SQL (ADR-011).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/worker/db/schema.ts',
  out: './migrations',
});
