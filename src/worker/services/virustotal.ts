// VirusTotal step of the scan pipeline (ADR-046), after our own scanner and the hash blocklist.
// Only risky types are checked, by hash; executables and macro documents VirusTotal has never seen
// are sent whole (the owner's Privacy Policy §4), others never leave R2. Every request is taken from
// a budget the key allows (per minute, per day, per person). VirusTotal never holds a file back for
// long: past the budget, on errors, or when an analysis takes too long, the file goes through on our
// own scanner's verdict, with the reason in `scan_detail`.
import { DAY_MS } from '../../shared/constants';
import { VtError, type VirusTotal, type VtReport } from '../adapters/virustotal';
import type { Ctx } from '../context';
import { track } from '../lib/analytics';
import { errorMessage, log } from '../lib/log';

type VtConfig = Awaited<ReturnType<Ctx['config']>>['virustotal'];

export type VtKind = 'executable' | 'macro' | 'script' | 'archive' | 'document';

// Sent whole when unknown: programs, installers, and Windows script droppers.
const EXECUTABLE = new Set(
  (
    'exe dll scr com cpl ocx sys msi msix msp appx appxbundle apk xapk apks aab jar dex ipa deb rpm ' +
    'appimage dmg pkg elf so dylib vbs vbe wsf wsh hta lnk jse pif'
  ).split(' '),
);
const MACRO = new Set('docm dotm xlsm xltm xlam pptm potm ppsm ppam sldm'.split(' '));
// Looked up by hash only: their content is too often personal to send anywhere.
const SCRIPT = new Set('bat cmd ps1 psm1'.split(' '));
const ARCHIVE = new Set('zip rar 7z gz tgz tar iso img cab'.split(' '));
const DOCUMENT = new Set('pdf doc xls ppt rtf docx xlsx pptx'.split(' '));
const UPLOADED_KINDS: ReadonlySet<VtKind> = new Set(['executable', 'macro']);

function extension(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Which risky type a file is (by name, then by its first bytes), or null: not checked. */
export function vtKind(name: string, sniffedMime: string | null): VtKind | null {
  const ext = extension(name);
  if (EXECUTABLE.has(ext)) return 'executable';
  if (MACRO.has(ext)) return 'macro';
  if (SCRIPT.has(ext)) return 'script';
  if (ARCHIVE.has(ext)) return 'archive';
  if (DOCUMENT.has(ext)) return 'document';
  if (sniffedMime === 'application/x-msdownload' || sniffedMime === 'application/x-elf')
    return 'executable';
  if (sniffedMime === 'application/pdf') return 'document';
  if (
    sniffedMime === 'application/zip' ||
    sniffedMime === 'application/x-7z-compressed' ||
    sniffedMime === 'application/x-rar-compressed'
  )
    return 'archive';
  return null;
}

/** Where to pick up again: the poll of an uploaded file, or (analysisId null) the lookup. */
export interface VtResume {
  n: number;
  analysisId: string | null;
}

export type VtStep =
  | { kind: 'done'; malicious: boolean; detail: string | null }
  | { kind: 'wait'; resume: VtResume; delaySeconds: number };

export interface VtInput {
  /** Whose budget it comes out of. */
  userId: string;
  sha256: string;
  size: number;
  name: string;
  sniffedMime: string | null;
  r2Key: string;
}

const pass = (detail: string | null): VtStep => ({ kind: 'done', malicious: false, detail });

function judge(rep: Pick<VtReport, 'malicious' | 'engines' | 'label'>, cfg: VtConfig): VtStep {
  if (rep.malicious < cfg.malicious_min) return pass(null);
  return {
    kind: 'done',
    malicious: true,
    detail: `VirusTotal: ${rep.label ?? 'malware'} (${rep.malicious}/${rep.engines})`,
  };
}

/** One request's worth of budget, or which limit is in the way. */
async function takeBudget(
  ctx: Ctx,
  vt: VirusTotal,
  cfg: VtConfig,
  userId: string,
): Promise<'ok' | 'minute' | 'day' | 'person'> {
  if (!vt.metered) return 'ok';
  const now = ctx.now();
  const DB = ctx.env.DB;
  // VirusTotal's day is UTC.
  const day = new Date(now).toISOString().slice(0, 10);
  const slots = {
    day: `d:${day}`,
    person: `u:${userId}:${day}`,
    minute: `m:${Math.floor(now / 60_000)}`,
  };
  const take = async (slot: string, max: number, ttl: number) =>
    Boolean(
      await DB.prepare(
        `INSERT INTO vt_budget (slot, used, expires_at) VALUES (?1, 1, ?3)
         ON CONFLICT (slot) DO UPDATE SET used = used + 1 WHERE used < ?2 RETURNING used`,
      )
        .bind(slot, max, now + ttl)
        .first(),
    );
  const giveBack = (...back: string[]) =>
    DB.batch(
      back.map((slot) =>
        DB.prepare(`UPDATE vt_budget SET used = used - 1 WHERE slot = ?1 AND used > 0`).bind(slot),
      ),
    );
  if (!(await take(slots.day, cfg.per_day, 2 * DAY_MS))) return 'day';
  if (!(await take(slots.person, cfg.per_user_day, 2 * DAY_MS))) {
    await giveBack(slots.day);
    return 'person';
  }
  if (!(await take(slots.minute, cfg.per_minute, 10 * 60_000))) {
    await giveBack(slots.day, slots.person);
    return 'minute';
  }
  return 'ok';
}

async function remember(
  ctx: Ctx,
  sha256: string,
  verdict: 'malicious' | 'clean' | 'unknown',
  rep: VtReport | null,
  uploaded: boolean,
): Promise<void> {
  await ctx.env.DB.prepare(
    `INSERT INTO vt_verdicts (sha256, verdict, malicious, engines, label, uploaded, checked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (sha256) DO UPDATE SET verdict = excluded.verdict, malicious = excluded.malicious,
       engines = excluded.engines, label = excluded.label, uploaded = MAX(uploaded, excluded.uploaded),
       checked_at = excluded.checked_at`,
  )
    .bind(
      sha256,
      verdict,
      rep?.malicious ?? 0,
      rep?.engines ?? 0,
      rep?.label ?? null,
      uploaded ? 1 : 0,
      ctx.now(),
    )
    .run();
}

async function rememberReport(
  ctx: Ctx,
  sha256: string,
  rep: VtReport,
  cfg: VtConfig,
  uploaded: boolean,
): Promise<VtStep> {
  const step = judge(rep, cfg);
  await remember(
    ctx,
    sha256,
    step.kind === 'done' && step.malicious ? 'malicious' : 'clean',
    rep,
    uploaded,
  );
  return step;
}

/** An earlier answer for the same file: malicious stays malicious, the rest for a while. */
async function cached(ctx: Ctx, sha256: string, cfg: VtConfig): Promise<VtStep | null> {
  const row = await ctx.env.DB.prepare(
    `SELECT verdict, malicious, engines, label, checked_at FROM vt_verdicts WHERE sha256 = ?1`,
  )
    .bind(sha256)
    .first<{
      verdict: string;
      malicious: number;
      engines: number;
      label: string | null;
      checked_at: number;
    }>();
  if (!row) return null;
  const age = ctx.now() - row.checked_at;
  if (row.verdict === 'malicious') return judge(row, cfg);
  if (row.verdict === 'clean' && age < cfg.cache_days * DAY_MS) return pass(null);
  if (row.verdict === 'unknown' && age < DAY_MS) return pass('VirusTotal: not known');
  return null;
}

/** The name VirusTotal sees: only the extension of the user's file name. */
function uploadName(name: string): string {
  const ext = extension(name);
  return `file.${/^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin'}`;
}

let alertedAuth = '';

/**
 * Checks one file. `done` is the verdict (VirusTotal's, or none: `malicious` false and why in
 * `detail`); `wait` means: send the scan again after `delaySeconds` with `resume`.
 */
export async function virusTotalStep(
  ctx: Ctx,
  input: VtInput,
  resume: VtResume | null,
): Promise<VtStep> {
  const vt = ctx.adapters.virustotal;
  const cfg = (await ctx.config()).virustotal;
  if (!vt || !cfg.enabled) return pass(null);
  const kind = vtKind(input.name, input.sniffedMime);
  if (!kind) return pass(null);
  const n = resume?.n ?? 0;
  const waitFor = (seconds: number, analysisId: string | null, limit: number, why: string) =>
    n >= limit
      ? pass(`VirusTotal: ${why}`)
      : ({
          kind: 'wait',
          resume: { n: n + 1, analysisId },
          delaySeconds: seconds,
        } satisfies VtStep);
  const nextMinute = () => 61 - Math.floor((ctx.now() % 60_000) / 1000);
  const outcome = (step: VtStep, what: string): VtStep => {
    track(ctx.env.ANALYTICS, 'virustotal', {
      blobs: [what, kind, step.kind === 'done' ? (step.malicious ? 'malicious' : 'pass') : 'wait'],
    });
    return step;
  };

  try {
    if (resume?.analysisId) {
      const b = await takeBudget(ctx, vt, cfg, input.userId);
      if (b !== 'ok')
        return waitFor(nextMinute(), resume.analysisId, cfg.max_waits, 'analysis not read');
      const rep = await vt.analysis(resume.analysisId);
      if (!rep)
        return outcome(
          waitFor(cfg.poll_seconds, resume.analysisId, cfg.max_polls, 'analysis took too long'),
          'poll',
        );
      return outcome(await rememberReport(ctx, input.sha256, rep, cfg, true), 'analysis');
    }

    const known = await cached(ctx, input.sha256, cfg);
    if (known) return outcome(known, 'cache');
    const b = await takeBudget(ctx, vt, cfg, input.userId);
    if (b === 'day') return outcome(pass('VirusTotal: daily limit reached'), 'budget');
    if (b === 'person')
      return outcome(pass("VirusTotal: this person's daily share used"), 'budget');
    if (b === 'minute') return waitFor(nextMinute(), null, cfg.max_waits, 'busy');
    const rep = await vt.lookup(input.sha256);
    if (rep !== 'unknown')
      return outcome(await rememberReport(ctx, input.sha256, rep, cfg, false), 'lookup');

    const sendable =
      cfg.upload &&
      UPLOADED_KINDS.has(kind) &&
      input.size > 0 &&
      input.size <= cfg.upload_max_bytes;
    if (!sendable) {
      await remember(ctx, input.sha256, 'unknown', null, false);
      return outcome(pass('VirusTotal: not known'), 'lookup');
    }
    const b2 = await takeBudget(ctx, vt, cfg, input.userId);
    if (b2 === 'minute') return waitFor(nextMinute(), null, cfg.max_waits, 'busy');
    if (b2 !== 'ok') {
      await remember(ctx, input.sha256, 'unknown', null, false);
      return outcome(pass('VirusTotal: not known, daily limit reached'), 'budget');
    }
    const obj = await ctx.env.BUCKET.get(input.r2Key);
    if (!obj) return pass(null);
    const analysisId = await vt.upload(
      new Uint8Array(await obj.arrayBuffer()),
      uploadName(input.name),
    );
    await remember(ctx, input.sha256, 'unknown', null, true);
    log.info('virustotal_upload', { kind, size: input.size });
    return outcome(
      { kind: 'wait', resume: { n: 0, analysisId }, delaySeconds: cfg.poll_seconds },
      'upload',
    );
  } catch (e) {
    const analysisId = resume?.analysisId ?? null;
    if (e instanceof VtError && e.kind === 'rate')
      return waitFor(nextMinute(), analysisId, cfg.max_waits, 'quota exceeded');
    if (e instanceof VtError && e.kind === 'auth') {
      const today = new Date(ctx.now()).toISOString().slice(0, 10);
      if (alertedAuth !== today) {
        alertedAuth = today;
        await ctx.env.NOTIFY_QUEUE.send({
          type: 'admin_alert',
          text: `VirusTotal menolak API key (${e.message}). File tetap diproses tanpa VirusTotal; periksa secret VIRUSTOTAL_API_KEY.`,
        });
      }
      return pass('VirusTotal: key refused');
    }
    log.warn('virustotal_error', { message: errorMessage(e) });
    return waitFor(60, analysisId, Math.min(3, cfg.max_waits), 'unavailable');
  }
}

/** Nightly: spent budget slots, and answers old enough to ask again. Malicious ones stay. */
export async function cleanupVirusTotal(ctx: Ctx): Promise<void> {
  const cfg = (await ctx.config()).virustotal;
  const now = ctx.now();
  const DB = ctx.env.DB;
  await DB.batch([
    DB.prepare(`DELETE FROM vt_budget WHERE expires_at < ?1`).bind(now),
    DB.prepare(`DELETE FROM vt_verdicts WHERE verdict != 'malicious' AND checked_at < ?1`).bind(
      now - cfg.cache_days * DAY_MS,
    ),
  ]);
}
