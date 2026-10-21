// Structured JSON logs for Workers Logs. Never log raw PII (emails, IPs, file names) — pass
// hashes or IDs instead (SPEC §13.3).
type Fields = Record<string, string | number | boolean | null | undefined>;

function emit(level: 'info' | 'warn' | 'error', event: string, fields?: Fields): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: Fields) => emit('info', event, fields),
  warn: (event: string, fields?: Fields) => emit('warn', event, fields),
  error: (event: string, fields?: Fields) => emit('error', event, fields),
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
