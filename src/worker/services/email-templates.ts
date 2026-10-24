// Transactional email bodies (plain text + minimal HTML). User-provided text is always escaped.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="id"><body style="margin:0;background:#f6f7fb;font-family:system-ui,sans-serif;color:#111827">
<div style="max-width:480px;margin:0 auto;padding:24px">
<div style="background:#fff;border-radius:16px;padding:24px;border:1px solid #e5e7eb">
<p style="margin:0 0 16px;font-weight:600;color:#4338ca">Zeiko</p>
<h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(title)}</h1>
${bodyHtml}
</div>
<p style="font-size:12px;color:#6b7280;text-align:center;margin-top:16px">Zeiko Cloud Storage · zeiko.biz.id</p>
</div></body></html>`;
}

export function otpEmail(otp: string): { subject: string; text: string; html: string } {
  const subject = `Kode masuk Zeiko: ${otp}`;
  const text = `Kode masuk Zeiko kamu: ${otp}\n\nKode berlaku 10 menit. Jangan bagikan kode ini ke siapa pun, termasuk yang mengaku dari Zeiko.\n\nKalau kamu tidak sedang masuk ke Zeiko, abaikan email ini.`;
  const html = layout(
    'Kode masuk kamu',
    `<p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:8px 0 16px">${escapeHtml(otp)}</p>
<p style="font-size:14px;color:#4b5563">Kode berlaku 10 menit. Jangan bagikan kode ini ke siapa pun, termasuk yang mengaku dari Zeiko.</p>
<p style="font-size:13px;color:#6b7280">Kalau kamu tidak sedang masuk ke Zeiko, abaikan email ini.</p>`,
  );
  return { subject, text, html };
}

export function shareEmail(p: {
  senderName: string;
  senderEmail: string;
  title: string;
  url: string;
  sizeText: string;
  expiresText: string | null;
  message: string | null;
  unsubscribeUrl: string;
  reportUrl: string;
}): { subject: string; text: string; html: string } {
  const subject = `${p.senderName} membagikan file lewat Zeiko`;
  const text = [
    `${p.senderName} membagikan "${p.title}" (${p.sizeText}) lewat Zeiko.`,
    p.message ? `\nPesan: ${p.message}\n` : '',
    `Unduh: ${p.url}`,
    p.expiresText ? `Berlaku sampai ${p.expiresText}.` : '',
    `\nDikirim atas nama ${p.senderEmail} · Laporkan penyalahgunaan: ${p.reportUrl}`,
    `Berhenti menerima email seperti ini: ${p.unsubscribeUrl}`,
  ]
    .filter(Boolean)
    .join('\n');
  const html = layout(
    subject,
    `<p style="font-size:14px">${escapeHtml(p.senderName)} membagikan <b>${escapeHtml(p.title)}</b> (${escapeHtml(p.sizeText)}).</p>
${p.message ? `<blockquote style="margin:12px 0;padding:12px;border-left:3px solid #c7d2fe;background:#eef2ff;white-space:pre-wrap;font-size:14px">${escapeHtml(p.message)}</blockquote>` : ''}
<p><a href="${escapeHtml(p.url)}" style="display:inline-block;background:#4338ca;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600">Unduh</a></p>
${p.expiresText ? `<p style="font-size:13px;color:#6b7280">Berlaku sampai ${escapeHtml(p.expiresText)}.</p>` : ''}
<p style="font-size:12px;color:#6b7280;margin-top:20px">Dikirim atas nama ${escapeHtml(p.senderEmail)} ·
<a href="${escapeHtml(p.reportUrl)}" style="color:#6b7280">Laporkan penyalahgunaan</a> ·
<a href="${escapeHtml(p.unsubscribeUrl)}" style="color:#6b7280">Berhenti menerima email seperti ini</a></p>`,
  );
  return { subject, text, html };
}

/** Generic notice: a title, a few paragraphs, an optional picture (a QR) and an optional button. */
export function noticeEmail(p: {
  title: string;
  paragraphs: string[];
  cta?: { label: string; url: string } | undefined;
  image?: { src: string; alt: string } | undefined;
}): { subject: string; text: string; html: string } {
  const text = [...p.paragraphs, p.cta ? `\n${p.cta.label}: ${p.cta.url}` : ''].join('\n\n').trim();
  const html = layout(
    p.title,
    `${p.paragraphs.map((x) => `<p style="font-size:14px;color:#374151">${escapeHtml(x)}</p>`).join('\n')}
${p.image ? `<p style="text-align:center"><img src="${escapeHtml(p.image.src)}" alt="${escapeHtml(p.image.alt)}" width="260" height="260" style="width:260px;height:260px;image-rendering:pixelated"></p>` : ''}
${p.cta ? `<p><a href="${escapeHtml(p.cta.url)}" style="display:inline-block;background:#4338ca;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600">${escapeHtml(p.cta.label)}</a></p>` : ''}`,
  );
  return { subject: p.title, text, html };
}
