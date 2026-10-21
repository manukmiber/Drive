// Deletes local dev data (.dev/): D1, KV and R2 shims. Demo data is re-seeded on next `npm run dev`.
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', '.dev');
rmSync(dir, { recursive: true, force: true });
console.log(`removed ${dir}`);
