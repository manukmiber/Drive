// Transactional email bodies (plain text + minimal HTML), in two languages (D14, ADR-069). User-provided
// text is always escaped.
import type { Strings } from '../../shared/strings.id';
import { strings, type Lang } from '../lib/lang';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(m: Strings['mail'], title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="${m.lang}"><body style="margin:0;background:#f6f7fb;font-family:system-ui,sans-serif;color:#111827">
<div style="max-width:480px;margin:0 auto;padding:24px">
<div style="background:#fff;border-radius:16px;padding:24px;border:1px solid #e5e7eb">
<p style="margin:0 0 16px;font-weight:600;color:#4338ca">Zeiko</p>
<h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(title)}</h1>
${bodyHtml}
</div>
<p style="font-size:12px;color:#6b7280;text-align:center;margin-top:16px">${escapeHtml(m.footer)}</p>
</div></body></html>`;
}

/** A share sent by email, in the sender's language (the recipient may have no account). */
export function shareEmail(
  lang: Lang,
  p: {
    senderName: string;
    senderEmail: string;
    title: string;
    url: string;
    sizeText: string;
    expiresText: string | null;
    message: string | null;
    unsubscribeUrl: string;
    reportUrl: string;
  },
): { subject: string; text: string; html: string } {
  const m = strings(lang).mail;
  const subject = m.shareSubject(p.senderName);
  const text = [
    m.shareLead(p.senderName, `"${p.title}"`, p.sizeText),
    p.message ? `\n${m.shareMessage(p.message)}\n` : '',
    `${m.shareDownload}: ${p.url}`,
    p.expiresText ? m.shareUntil(p.expiresText) : '',
    `\n${m.shareSentFor(p.senderEmail)} · ${m.shareReport}: ${p.reportUrl}`,
    `${m.unsubscribe}: ${p.unsubscribeUrl}`,
  ]
    .filter(Boolean)
    .join('\n');
  const html = layout(
    m,
    subject,
    `<p style="font-size:14px">${m.shareLead(escapeHtml(p.senderName), `<b>${escapeHtml(p.title)}</b>`, escapeHtml(p.sizeText))}</p>
${p.message ? `<blockquote style="margin:12px 0;padding:12px;border-left:3px solid #c7d2fe;background:#eef2ff;white-space:pre-wrap;font-size:14px">${escapeHtml(p.message)}</blockquote>` : ''}
<p><a href="${escapeHtml(p.url)}" style="display:inline-block;background:#4338ca;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600">${escapeHtml(m.shareDownload)}</a></p>
${p.expiresText ? `<p style="font-size:13px;color:#6b7280">${escapeHtml(m.shareUntil(p.expiresText))}</p>` : ''}
<p style="font-size:12px;color:#6b7280;margin-top:20px">${escapeHtml(m.shareSentFor(p.senderEmail))} ·
<a href="${escapeHtml(p.reportUrl)}" style="color:#6b7280">${escapeHtml(m.shareReport)}</a> ·
<a href="${escapeHtml(p.unsubscribeUrl)}" style="color:#6b7280">${escapeHtml(m.unsubscribe)}</a></p>`,
  );
  return { subject, text, html };
}

/** Generic notice: a title, a few paragraphs, an optional picture (a QR) and an optional button. */
export function noticeEmail(
  lang: Lang,
  p: {
    title: string;
    paragraphs: string[];
    cta?: { label: string; url: string } | undefined;
    image?: { src: string; alt: string } | undefined;
  },
): { subject: string; text: string; html: string } {
  const text = [...p.paragraphs, p.cta ? `\n${p.cta.label}: ${p.cta.url}` : ''].join('\n\n').trim();
  const html = layout(
    strings(lang).mail,
    p.title,
    `${p.paragraphs.map((x) => `<p style="font-size:14px;color:#374151">${escapeHtml(x)}</p>`).join('\n')}
${p.image ? `<p style="text-align:center"><img src="${escapeHtml(p.image.src)}" alt="${escapeHtml(p.image.alt)}" width="260" height="260" style="width:260px;height:260px;image-rendering:pixelated"></p>` : ''}
${p.cta ? `<p><a href="${escapeHtml(p.cta.url)}" style="display:inline-block;background:#4338ca;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600">${escapeHtml(p.cta.label)}</a></p>` : ''}`,
  );
  return { subject: p.title, text, html };
}
