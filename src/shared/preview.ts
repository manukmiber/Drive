// Which files can be previewed inline, and how (SPEC §8.4). SVG/HTML/XML are shown as source text,
// never rendered.
export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text';

const RASTER = /^image\/(jpeg|png|webp|avif|gif|bmp|heic|heif)$/;
const TEXT_EXT = new Set([
  'txt',
  'md',
  'csv',
  'tsv',
  'json',
  'xml',
  'svg',
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'cs',
  'php',
  'rb',
  'sh',
  'yml',
  'yaml',
  'toml',
  'ini',
  'sql',
  'log',
  'env',
  'conf',
  'srt',
  'vtt',
]);

export function previewKind(
  mime: string | null,
  name: string,
  size: number,
  textMax: number,
): PreviewKind | null {
  const m = (mime ?? '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (RASTER.test(m)) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (
    (m.startsWith('text/') ||
      m === 'application/json' ||
      m === 'application/xml' ||
      m === 'image/svg+xml' ||
      TEXT_EXT.has(ext)) &&
    size <= textMax
  ) {
    return 'text';
  }
  return null;
}

/** Content-Type used when serving a preview: active formats are downgraded to plain text. */
export function previewContentType(kind: PreviewKind, mime: string | null): string {
  if (kind === 'text') return 'text/plain; charset=utf-8';
  if (kind === 'pdf') return 'application/pdf';
  return mime ?? 'application/octet-stream';
}
