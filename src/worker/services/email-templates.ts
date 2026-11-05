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
  // Zeiko's light scheme (ADR-101): navy ink on white, the kawung mark from the website (the same
  // 96px image the Zeiko Account's own emails use).
  return `<!doctype html><html lang="${m.lang}"><body style="margin:0;background:#f4f5f8;font-family:'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1f2639">
<div style="max-width:480px;margin:0 auto;padding:24px">
<div style="background:#fff;border-radius:14px;padding:24px;border:1px solid #e3e5eb">
<p style="margin:0 0 20px;font-weight:800;font-size:16px;color:#1f2639"><img src="https://zeiko.biz.id/img/mark-mail.png" width="28" height="28" alt="" style="width:28px;height:28px;vertical-align:middle;margin-right:8px;border:0">Zeiko Drive</p>
<h1 style="font-size:20px;font-weight:800;line-height:1.25;margin:0 0 12px;color:#1f2639">${escapeHtml(title)}</h1>
${bodyHtml}
</div>
<p style="font-size:12px;color:#586074;text-align:center;margin-top:16px">${escapeHtml(m.footer)}</p>
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
${p.message ? `<blockquote style="margin:12px 0;padding:12px 14px;border:1px solid #e3e5eb;border-radius:8px;background:#f4f5f8;white-space:pre-wrap;font-size:14px">${escapeHtml(p.message)}</blockquote>` : ''}
<p><a href="${escapeHtml(p.url)}" style="display:inline-block;background:#1f2639;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">${escapeHtml(m.shareDownload)}</a></p>
${p.expiresText ? `<p style="font-size:13px;color:#586074">${escapeHtml(m.shareUntil(p.expiresText))}</p>` : ''}
<p style="font-size:12px;color:#586074;margin-top:20px">${escapeHtml(m.shareSentFor(p.senderEmail))} ·
<a href="${escapeHtml(p.reportUrl)}" style="color:#586074">${escapeHtml(m.shareReport)}</a> ·
<a href="${escapeHtml(p.unsubscribeUrl)}" style="color:#586074">${escapeHtml(m.unsubscribe)}</a></p>`,
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
    `${p.paragraphs.map((x) => `<p style="font-size:14px;color:#1f2639">${escapeHtml(x)}</p>`).join('\n')}
${p.image ? `<p style="text-align:center"><img src="${escapeHtml(p.image.src)}" alt="${escapeHtml(p.image.alt)}" width="260" height="260" style="width:260px;height:260px;image-rendering:pixelated"></p>` : ''}
${p.cta ? `<p><a href="${escapeHtml(p.cta.url)}" style="display:inline-block;background:#1f2639;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">${escapeHtml(p.cta.label)}</a></p>` : ''}`,
  );
  return { subject: p.title, text, html };
}
