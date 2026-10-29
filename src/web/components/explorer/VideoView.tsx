// The video in the preview, with subtitles (D13): a .srt/.vtt beside the video (same base name first),
// another one from the folder, or one picked from the device. The file is read and turned into WebVTT
// here and attached through a blob: URL; nothing is uploaded.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../lib/i18n';
import { listChildren, previewInfo, type NodeDto } from '../../lib/files';
import {
  isSubtitleName,
  loadSubtitleSize,
  saveSubtitleSize,
  subtitleLabel,
  subtitleMatch,
  toVtt,
  type SubtitleSize,
} from '../../lib/subtitles';
import { cn } from '../../lib/cn';

/** A folder with more files than this is only searched this far for subtitles. */
const MAX_PAGES = 10;

async function subtitlesIn(folderId: string): Promise<NodeDto[]> {
  const out: NodeDto[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await listChildren(folderId, 'name', 'asc', cursor);
    for (const n of res.items)
      if (n.kind === 'file' && n.status === 'ready' && isSubtitleName(n.name)) out.push(n);
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return out;
}

async function vttUrlOf(source: NodeDto | File): Promise<string> {
  let bytes: Uint8Array;
  if (source instanceof File) bytes = new Uint8Array(await source.arrayBuffer());
  else {
    const { url } = await previewInfo(source.id);
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`subtitle ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  const vtt = toVtt(source.name, bytes);
  return URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
}

type Choice = { kind: 'off' } | { kind: 'node'; id: string } | { kind: 'device'; file: File };

const SIZES: SubtitleSize[] = ['sm', 'md', 'lg'];

export function VideoView({ url, node }: { url: string; node: NodeDto }) {
  const subs = useQuery({
    queryKey: ['subtitles', node.parentId],
    queryFn: () => subtitlesIn(node.parentId!),
    enabled: Boolean(node.parentId),
    staleTime: 60_000,
  });
  const ranked = useMemo(
    () =>
      (subs.data ?? [])
        .map((s) => ({ node: s, score: subtitleMatch(node.name, s.name) }))
        .sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name)),
    [subs.data, node.name],
  );
  const best = ranked[0]?.score ? ranked[0].node.id : null;

  const [picked, setPicked] = useState<Choice | null>(null);
  const choice: Choice = picked ?? (best ? { kind: 'node', id: best } : { kind: 'off' });
  const source =
    choice.kind === 'device'
      ? choice.file
      : choice.kind === 'node'
        ? (ranked.find((r) => r.node.id === choice.id)?.node ?? null)
        : null;

  const [track, setTrack] = useState<{ for: NodeDto | File; url: string } | null>(null);
  const [failed, setFailed] = useState<NodeDto | File | null>(null);
  useEffect(() => {
    if (!source) return;
    let alive = true;
    let made: string | null = null;
    vttUrlOf(source).then(
      (u) => {
        made = u;
        if (alive) setTrack({ for: source, url: u });
        else URL.revokeObjectURL(u);
      },
      () => alive && setFailed(source),
    );
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [source]);
  const vtt = source && track?.for === source ? track.url : null;

  const trackEl = useRef<HTMLTrackElement>(null);
  useEffect(() => {
    // A track added after the video started isn't shown by `default` alone.
    if (vtt && trackEl.current) trackEl.current.track.mode = 'showing';
  }, [vtt]);

  const [size, setSize] = useState<SubtitleSize>(loadSubtitleSize);
  const fileInput = useRef<HTMLInputElement>(null);
  const label = (s: NodeDto) => subtitleLabel(node.name, s.name);
  const value = choice.kind === 'node' ? choice.id : choice.kind;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <video
        src={url}
        controls
        autoPlay
        data-subs={size}
        className="min-h-0 max-w-full flex-1 object-contain"
      >
        {vtt && (
          <track
            key={vtt}
            ref={trackEl}
            kind="subtitles"
            src={vtt}
            label={source instanceof File ? source.name : source ? label(source) : ''}
            default
          />
        )}
      </video>
      {(ranked.length > 0 || choice.kind === 'device' || subs.isSuccess) && (
        <div className="flex w-full max-w-xl flex-wrap items-center justify-center gap-2 text-sm">
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 text-white/70">{t.files.subs.label}</span>
            <select
              value={value}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'pick') fileInput.current?.click();
                else if (v === 'off') setPicked({ kind: 'off' });
                else if (v !== 'device') setPicked({ kind: 'node', id: v });
              }}
              className="min-w-0 flex-1 truncate rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-white"
            >
              <option value="off" className="text-gray-900">
                {t.files.subs.off}
              </option>
              {ranked.map((r) => (
                <option key={r.node.id} value={r.node.id} className="text-gray-900">
                  {label(r.node)}
                </option>
              ))}
              {choice.kind === 'device' && (
                <option value="device" className="text-gray-900">
                  {t.files.subs.device(choice.file.name)}
                </option>
              )}
              <option value="pick" className="text-gray-900">
                {t.files.subs.fromDevice}
              </option>
            </select>
          </label>
          <input
            ref={fileInput}
            type="file"
            accept=".srt,.vtt"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) setPicked({ kind: 'device', file: f });
            }}
          />
          <div
            role="group"
            aria-label={t.files.subs.size}
            className="flex overflow-hidden rounded-full border border-white/20"
          >
            {SIZES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={size === s}
                title={t.files.subs.sizes[s]}
                aria-label={`${t.files.subs.size}: ${t.files.subs.sizes[s]}`}
                onClick={() => {
                  setSize(s);
                  saveSubtitleSize(s);
                }}
                className={cn(
                  'px-3 py-1.5 leading-none',
                  size === s ? 'bg-white text-gray-900' : 'text-white hover:bg-white/10',
                )}
              >
                <span className={s === 'sm' ? 'text-xs' : s === 'lg' ? 'text-base' : 'text-sm'}>
                  A
                </span>
              </button>
            ))}
          </div>
          {failed && failed === source && (
            <p role="alert" className="w-full text-center text-xs text-red-300">
              {t.files.subs.failed}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
