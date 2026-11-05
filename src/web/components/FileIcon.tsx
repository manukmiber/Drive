import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
} from 'lucide-react';
import type { NodeDto } from '../lib/files';
import { cn } from '../lib/cn';
import { FolderGlyph } from './FolderGlyph';

// What kind of file a row holds. The glyph names the kind (picture, video, archive…); colour is
// left to the folder colours people pick (ADR-058), so the files themselves stay in ink and a
// folder someone made red is the thing that stands out.
export function iconFor(node: Pick<NodeDto, 'mime' | 'name'>) {
  const m = node.mime ?? '';
  const ext = node.name.split('.').pop()?.toLowerCase() ?? '';
  const color = 'text-[var(--muted)]';
  if (m.startsWith('image/')) return { Icon: FileImage, color };
  if (m.startsWith('video/')) return { Icon: FileVideo, color };
  if (m.startsWith('audio/')) return { Icon: FileAudio, color };
  if (/zip|rar|7z|tar|gzip|zstd/.test(m) || ['zip', 'rar', '7z', 'gz', 'zst', 'tar'].includes(ext))
    return { Icon: FileArchive, color };
  if (/sheet|excel|csv/.test(m) || ['xlsx', 'xls', 'csv', 'ods'].includes(ext))
    return { Icon: FileSpreadsheet, color };
  if (['js', 'ts', 'py', 'json', 'html', 'css', 'go', 'rs', 'java', 'c', 'cpp', 'sh'].includes(ext))
    return { Icon: FileCode, color };
  if (
    m.startsWith('text/') ||
    m === 'application/pdf' ||
    ['pdf', 'doc', 'docx', 'txt', 'md', 'odt'].includes(ext)
  )
    return { Icon: FileText, color };
  return { Icon: File, color };
}

/** The file's extension as people know it ("pdf", "jpg", "docx"), or null when it has none. */
export function extLabel(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return ext.length <= 4 && /^[a-z0-9]+$/.test(ext) ? ext : null;
}

export function FileIcon({
  node,
  className = 'h-5 w-5',
}: {
  node: Pick<NodeDto, 'kind' | 'mime' | 'name'> & { decor?: NodeDto['decor'] };
  className?: string;
}) {
  if (node.kind === 'folder')
    return <FolderGlyph color={node.decor?.color} icon={node.decor?.icon} className={className} />;
  const { Icon, color } = iconFor(node);
  return <Icon className={`${className} ${color} shrink-0`} aria-hidden="true" />;
}

/**
 * A row's leading tile (ADR-101): the logo's rounded square, holding a folder's glyph or a file's
 * extension in heavy lowercase, so "pdf" reads at a glance without a colour code. Files with no
 * short extension get their kind's glyph instead.
 */
export function TypeTile({
  node,
  size = 'md',
  className,
}: {
  node: Pick<NodeDto, 'kind' | 'mime' | 'name'> & { decor?: NodeDto['decor'] };
  size?: 'md' | 'lg';
  className?: string;
}) {
  const ext = node.kind === 'file' ? extLabel(node.name) : null;
  if (size === 'lg')
    return ext ? (
      <span
        aria-hidden="true"
        className={cn(
          'text-[clamp(1.5rem,6vw,2.25rem)] leading-none font-extrabold tracking-tight text-[var(--ink)] select-none',
          className,
        )}
      >
        {ext}
      </span>
    ) : (
      <FileIcon node={node} className={cn('h-10 w-10', className)} />
    );
  return (
    <span aria-hidden="true" className={cn('z-tile h-10 w-10', className)}>
      {ext ? (
        <span
          className={cn(
            'leading-none font-extrabold tracking-tight select-none',
            ext.length > 3 ? 'text-[10px]' : 'text-[11px]',
          )}
        >
          {ext}
        </span>
      ) : (
        <FileIcon node={node} className="h-5 w-5" />
      )}
    </span>
  );
}
