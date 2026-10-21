// Tiny server-rendered pages for share links (password form, dead link, bot preview).
// No scripts; inline styles are allowed by the app CSP.
import { escapeHtml } from '../services/email-templates';

const STYLE = `body{margin:0;font-family:system-ui,sans-serif;background:#f6f7fb;color:#111827;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:28px;max-width:380px;width:calc(100% - 32px)}
.brand{color:#4338ca;font-weight:700;margin:0 0 16px}h1{font-size:18px;margin:0 0 8px}p{color:#4b5563;font-size:14px}
input{width:100%;box-sizing:border-box;height:44px;border:1px solid #e5e7eb;border-radius:12px;padding:0 12px;font-size:15px}
button,.btn{display:inline-block;margin-top:12px;width:100%;height:44px;border:0;border-radius:999px;background:#4338ca;color:#fff;font-size:15px;font-weight:600;text-align:center;line-height:44px;text-decoration:none;cursor:pointer}
.err{color:#dc2626}.foot{margin-top:18px;font-size:12px;color:#6b7280;display:flex;justify-content:space-between}
.foot a{color:#6b7280}@media(prefers-color-scheme:dark){body{background:#0f1117;color:#e5e7eb}.card{background:#161925;border-color:#262a36}p{color:#9ca3af}input{background:#0f1117;color:#e5e7eb;border-color:#262a36}}`;

export function page(
  title: string,
  body: string,
  opts: { status?: number; head?: string; reportUrl?: string } = {},
): Response {
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)} · Zeiko</title>${opts.head ?? ''}<style>${STYLE}</style></head>
<body><main class="card"><p class="brand">Zeiko</p>${body}
<div class="foot"><a href="/">zeiko.biz.id</a>${opts.reportUrl ? `<a href="${escapeHtml(opts.reportUrl)}">Laporkan</a>` : ''}</div>
</main></body></html>`;
  return new Response(html, {
    status: opts.status ?? 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

const BOTS =
  /WhatsApp|TelegramBot|facebookexternalhit|Facebot|Twitterbot|Slackbot|Discordbot|LinkedInBot|Googlebot|bingbot|Applebot|SkypeUriPreview|redditbot|Pinterest|vkShare|Embedly|Line\//i;

export function isPreviewBot(ua: string | null): boolean {
  return Boolean(ua && BOTS.test(ua));
}
