// Mentions and links in a Space message (ADR-096, ADR-098). On the wire a mention is `<@userId>`;
// in the box the person types `@Name`, picked from a list, and the app swaps one for the other.

/** A mention the person picked: what the box shows after `@`, and whom it means. */
export interface MentionPick {
  id: string;
  label: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `@Label` → `<@id>` for what was picked; longer labels first, so "Ana Bell" wins over "Ana". */
export function toWire(text: string, picks: readonly MentionPick[]): string {
  let out = text;
  for (const p of [...picks].sort((a, b) => b.label.length - a.label.length)) {
    if (!p.label) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escape(p.label)}(?![\\p{L}\\p{N}_])`, 'gu');
    out = out.replace(re, (_, lead: string) => `${lead}<@${p.id}>`);
  }
  return out;
}

/** `<@id>` → `@Name`, for editing a message in the box; the names become picks again. */
export function fromWire(
  text: string,
  nameOf: (id: string) => string | null,
): { text: string; picks: MentionPick[] } {
  const picks = new Map<string, MentionPick>();
  const out = text.replace(/<@([A-Za-z0-9_-]{1,64})>/g, (whole, id: string) => {
    const label = nameOf(id);
    if (!label) return whole;
    picks.set(id, { id, label });
    return `@${label}`;
  });
  return { text: out, picks: [...picks.values()] };
}

/** What is being typed after an `@` right before the caret, or null when not a mention. */
export function mentionQuery(beforeCaret: string): string | null {
  const m = /(?:^|\s)@([^\s@<>]{0,30})$/u.exec(beforeCaret);
  return m ? m[1]! : null;
}

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; id: string }
  | { kind: 'link'; href: string; text: string };

const TOKENS = /<@([A-Za-z0-9_-]{1,64})>|https?:\/\/[^\s<>"']+/g;
const TRAILING = '.,;:!?)]}';

const count = (s: string, c: string) => s.split(c).length - 1;

/** A link without the sentence's punctuation after it; a `)` stays when the link opened one. */
function trimLink(href: string): string {
  let out = href;
  for (;;) {
    const last = out.at(-1);
    if (!last || !TRAILING.includes(last)) return out;
    if (last === ')' && count(out, '(') >= count(out, ')')) return out;
    out = out.slice(0, -1);
  }
}

/** A message's text cut into plain text, mentions and web links (http and https only). */
export function parts(text: string): Part[] {
  const out: Part[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKENS)) {
    const start = m.index;
    if (start > at) out.push({ kind: 'text', text: text.slice(at, start) });
    if (m[1]) {
      out.push({ kind: 'mention', id: m[1] });
      at = start + m[0].length;
      continue;
    }
    const href = trimLink(m[0]);
    out.push({ kind: 'link', href, text: href });
    at = start + href.length;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}
