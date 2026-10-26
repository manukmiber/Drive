// How many uploads and downloads run at once on a device (ADR-053): the limits, the presets and
// the connection hint. No browser APIs here (the store is `transfer.ts`), so tests can use it.

export interface TransferSettings {
  /** Files uploading at once. */
  uploadFiles: number;
  /** Parts of one big file uploading at once. */
  uploadParts: number;
  /** Files downloading at once (the app's download queue). */
  downloadFiles: number;
  /** Ask the screen to stay on while something transfers (phones stop tabs that sleep). */
  keepAwake: boolean;
}

export interface TransferLimits {
  uploadFilesMax: number;
  uploadPartsMax: number;
  downloadFilesMax: number;
  defaults: Omit<TransferSettings, 'keepAwake'>;
}

export type PresetId = 'saver' | 'normal' | 'fast' | 'max';

/** The owner's ceiling (ADR-053); config can only lower it. */
export const HARD_CAP = 20;

export const FALLBACK_LIMITS: TransferLimits = {
  uploadFilesMax: HARD_CAP,
  uploadPartsMax: 8,
  downloadFilesMax: HARD_CAP,
  defaults: { uploadFiles: 3, uploadParts: 4, downloadFiles: 3 },
};

const clampInt = (v: unknown, min: number, max: number, def: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def;
  return Math.min(max, Math.max(min, n));
};

/** Limits from the public config, never above HARD_CAP and never below 1. */
export function limitsFrom(config: Record<string, unknown> | undefined): TransferLimits {
  const num = (k: string, def: number) => {
    const v = config?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : def;
  };
  const uploadFilesMax = clampInt(
    num('upload_parallel_files_cap', HARD_CAP),
    1,
    HARD_CAP,
    HARD_CAP,
  );
  const uploadPartsMax = clampInt(num('upload_part_concurrency_cap', 8), 1, 16, 8);
  const downloadFilesMax = clampInt(
    num('download_parallel_files_cap', HARD_CAP),
    1,
    HARD_CAP,
    HARD_CAP,
  );
  return {
    uploadFilesMax,
    uploadPartsMax,
    downloadFilesMax,
    defaults: {
      uploadFiles: clampInt(num('upload_max_parallel_files', 3), 1, uploadFilesMax, 3),
      uploadParts: clampInt(num('upload_part_concurrency', 4), 1, uploadPartsMax, 4),
      downloadFiles: clampInt(num('download_max_parallel_files', 3), 1, downloadFilesMax, 3),
    },
  };
}

/** Saved values within the limits; anything missing or broken falls back to the defaults. */
export function clampSettings(
  s: Partial<TransferSettings> | null | undefined,
  l: TransferLimits,
): TransferSettings {
  return {
    uploadFiles: clampInt(s?.uploadFiles, 1, l.uploadFilesMax, l.defaults.uploadFiles),
    uploadParts: clampInt(s?.uploadParts, 1, l.uploadPartsMax, l.defaults.uploadParts),
    downloadFiles: clampInt(s?.downloadFiles, 1, l.downloadFilesMax, l.defaults.downloadFiles),
    keepAwake: typeof s?.keepAwake === 'boolean' ? s.keepAwake : true,
  };
}

/** Ready-made picks; "normal" is whatever config says. All are clamped to the limits. */
export function presetValues(id: PresetId, l: TransferLimits): Omit<TransferSettings, 'keepAwake'> {
  const pick = (v: Omit<TransferSettings, 'keepAwake'>) => ({
    uploadFiles: Math.min(v.uploadFiles, l.uploadFilesMax),
    uploadParts: Math.min(v.uploadParts, l.uploadPartsMax),
    downloadFiles: Math.min(v.downloadFiles, l.downloadFilesMax),
  });
  switch (id) {
    case 'saver':
      return pick({ uploadFiles: 1, uploadParts: 2, downloadFiles: 1 });
    case 'normal':
      return pick(l.defaults);
    case 'fast':
      return pick({ uploadFiles: 8, uploadParts: 6, downloadFiles: 8 });
    case 'max':
      return {
        uploadFiles: l.uploadFilesMax,
        uploadParts: l.uploadPartsMax,
        downloadFiles: l.downloadFilesMax,
      };
  }
}

export function presetOf(s: TransferSettings, l: TransferLimits): PresetId | null {
  for (const id of ['saver', 'normal', 'fast', 'max'] as const) {
    const p = presetValues(id, l);
    if (
      p.uploadFiles === s.uploadFiles &&
      p.uploadParts === s.uploadParts &&
      p.downloadFiles === s.downloadFiles
    )
      return id;
  }
  return null;
}

/** navigator.connection, where the browser has it (Chrome, Android). */
export interface ConnectionHint {
  effectiveType?: string;
  downlink?: number;
  saveData?: boolean;
}

/** A suggestion for this connection, or null when the browser does not say. */
export function suggestPreset(c: ConnectionHint | undefined | null): PresetId | null {
  if (!c) return null;
  if (c.saveData) return 'saver';
  if (c.effectiveType === 'slow-2g' || c.effectiveType === '2g') return 'saver';
  if (c.effectiveType === '3g') return 'normal';
  if (typeof c.downlink === 'number' && c.downlink > 0) {
    // Chrome caps downlink at 10 Mbps, so "fast" is as far as it can tell.
    if (c.downlink < 1.5) return 'saver';
    if (c.downlink < 5) return 'normal';
    return 'fast';
  }
  return c.effectiveType === '4g' ? 'fast' : null;
}
