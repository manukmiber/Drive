// A file's type from its name, for uploads whose client sends none or only
// application/octet-stream (WebDAV, ADR-089). The scanner still sniffs the bytes and that is what a
// download is served as (SPEC §14.4); this only lets the explorer, the gallery and search know what
// a file is before then.
const BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  jxl: 'image/jxl',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  dng: 'image/x-adobe-dng',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  ts: 'video/mp2t',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  wav: 'audio/wav',
  amr: 'audio/amr',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  apk: 'application/vnd.android.package-archive',
};

/** The type a name's extension stands for, or null when unknown. */
export function mimeFromName(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

const TEXT_EXT = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'xml',
  'html',
  'htm',
  'log',
  'ini',
  'yaml',
  'yml',
  'toml',
  'js',
  'mjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'cs',
  'go',
  'rs',
  'php',
  'rb',
  'sh',
  'sql',
  'css',
  'scss',
  'srt',
  'vtt',
  'tex',
  'rtf',
]);
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type TextKind = 'text' | 'pdf' | 'docx' | 'xlsx';

/** D6 (ADR-090): which reader can take a file's text in the browser, or null when none can. */
export function textKind(name: string, mime: string | null): TextKind | null {
  const m = (mime || mimeFromName(name) || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m === DOCX || ext === 'docx') return 'docx';
  if (m === XLSX || ext === 'xlsx') return 'xlsx';
  if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml') return 'text';
  if (TEXT_EXT.has(ext)) return 'text';
  return null;
}
