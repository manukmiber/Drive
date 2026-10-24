// The small Markdown subset the policy pages are written in (ADR-045): ## and ### headings,
// paragraphs, "- " and "1. " lists, | tables |, **bold**, and links/email addresses made clickable.
// Everything is rendered as React text, never as HTML.
import type { ReactNode } from 'react';

type Block =
  | { k: 'h2' | 'h3'; text: string }
  | { k: 'p'; text: string }
  | { k: 'ul'; items: string[] }
  | { k: 'ol'; items: string[]; start: number }
  | { k: 'table'; head: string[]; rows: string[][] };

const LIST = /^- /;
const OLIST = /^(\d+)\. /;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

function parse(md: string): Block[] {
  const lines = md.split('\n');
  const out: Block[] = [];
  let i = 0;
  const isStart = (l: string) =>
    l.startsWith('## ') ||
    l.startsWith('### ') ||
    l.startsWith('|') ||
    LIST.test(l) ||
    OLIST.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
    } else if (line.startsWith('### ')) {
      out.push({ k: 'h3', text: line.slice(4).trim() });
      i++;
    } else if (line.startsWith('## ')) {
      out.push({ k: 'h2', text: line.slice(3).trim() });
      i++;
    } else if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) rows.push(cells(lines[i++]!));
      const [head = [], , ...body] = rows; // the second row is the | --- | separator
      out.push({ k: 'table', head, rows: body });
    } else if (LIST.test(line)) {
      const items: string[] = [];
      while (i < lines.length && LIST.test(lines[i]!)) items.push(lines[i++]!.slice(2).trim());
      out.push({ k: 'ul', items });
    } else if (OLIST.test(line)) {
      const start = Number(OLIST.exec(line)![1]);
      const items: string[] = [];
      while (i < lines.length && OLIST.test(lines[i]!))
        items.push(lines[i++]!.replace(OLIST, '').trim());
      out.push({ k: 'ol', items, start });
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !isStart(lines[i]!))
        para.push(lines[i++]!.trim());
      out.push({ k: 'p', text: para.join(' ') });
    }
  }
  return out;
}

const INLINE =
  /\*\*(.+?)\*\*|(https?:\/\/[^\s)]+[^\s).,;])|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}.${n++}`;
    if (m[1] !== undefined) out.push(<strong key={k}>{inline(m[1], k)}</strong>);
    else if (m[2])
      out.push(
        <a key={k} href={m[2]} className="text-brand-700 underline" rel="noopener">
          {m[2]}
        </a>,
      );
    else
      out.push(
        <a key={k} href={`mailto:${m[3]}`} className="text-brand-700 underline">
          {m[3]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** "3. Konten dan Aktivitas" → "3-konten-dan-aktivitas" (for #links to a section). */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-[var(--fg-muted)]">
      {parse(source).map((b, i) => {
        const key = String(i);
        switch (b.k) {
          case 'h2':
            return (
              <h2
                key={key}
                id={headingId(b.text)}
                className="scroll-mt-4 pt-5 text-base font-semibold text-[var(--fg)]"
              >
                {inline(b.text, key)}
              </h2>
            );
          case 'h3':
            return (
              <h3 key={key} className="pt-2 font-medium text-[var(--fg)]">
                {inline(b.text, key)}
              </h3>
            );
          case 'p':
            return <p key={key}>{inline(b.text, key)}</p>;
          case 'ul':
            return (
              <ul key={key} className="list-disc space-y-1.5 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `${key}.${j}`)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key} start={b.start} className="list-decimal space-y-1.5 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `${key}.${j}`)}</li>
                ))}
              </ol>
            );
          case 'table':
            return (
              <div key={key} className="overflow-x-auto rounded-xl border border-[var(--border)]">
                <table className="w-full min-w-[32rem] border-collapse text-left text-[13px]">
                  <thead className="bg-[var(--bg-subtle)] text-[var(--fg)]">
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j} scope="col" className="px-3 py-2 font-semibold">
                          {inline(h, `${key}.h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j} className="border-t border-[var(--border)] align-top">
                        {r.map((c, x) => (
                          <td key={x} className="px-3 py-2">
                            {inline(c, `${key}.${j}.${x}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
