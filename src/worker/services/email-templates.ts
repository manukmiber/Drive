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
