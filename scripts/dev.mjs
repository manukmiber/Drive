// Runs the API (Node + shims) and Vite together. Ctrl+C stops both.
import { spawn } from 'node:child_process';

const procs = [
  ['api', 'npm', ['run', 'dev:api']],
  ['web', 'npm', ['run', 'dev:web']],
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = name === 'api' ? '\x1b[36m[api]\x1b[0m' : '\x1b[35m[web]\x1b[0m';
  for (const s of [p.stdout, p.stderr]) {
    s.on('data', (d) => {
      for (const line of d.toString().split('\n')) if (line.trim()) console.log(`${tag} ${line}`);
    });
  }
  p.on('exit', (code) => {
    console.log(`${tag} exited (${code})`);
    for (const other of procs) if (other !== p) other.kill();
    process.exit(code ?? 0);
  });
  return p;
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => procs.forEach((p) => p.kill(sig)));
