// Tiny server-rendered pages for share links (password form, dead link, bot preview).
// No scripts; inline styles are allowed by the app CSP.
import { escapeHtml } from '../services/email-templates';

// Zeiko's dark scheme (ADR-101, after proxychat/DESIGN.md): navy ground, cream ink, 1px lines, 8px
// controls and 14px cards. These pages load no fonts (the CSP allows none), so system-ui stands in.
const STYLE = `.ad{margin-top:20px;border-top:1px solid #2a3142;padding-top:12px;font-size:13px}.ad a{display:flex;gap:10px;color:#e9e4da;text-decoration:none}.ad img{border-radius:8px;flex:none}.adl{display:block;color:#a3a9b8;font-size:11px;margin-bottom:6px}.adr{display:block!important;color:#a3a9b8!important;font-size:11px;margin-top:6px}
body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#10131b;color:#e9e4da;color-scheme:dark;display:flex;min-height:100vh;align-items:center;justify-content:center;-webkit-font-smoothing:antialiased}
.card{background:#1a2030;border:1px solid #2a3142;border-radius:14px;padding:28px;max-width:380px;width:calc(100% - 32px);box-sizing:border-box}
.brand{display:flex;align-items:center;gap:10px;color:#eee6d7;font-weight:800;font-size:17px;letter-spacing:-.01em;margin:0 0 20px}.brand svg{width:28px;height:28px;flex:none}
h1{font-size:20px;font-weight:800;letter-spacing:-.015em;line-height:1.25;color:#eee6d7;margin:0 0 8px}p{color:#a3a9b8;font-size:14px;line-height:1.55}
input{width:100%;box-sizing:border-box;height:44px;border:1px solid #3d465b;border-radius:8px;padding:0 12px;font-size:16px;background:#10131b;color:#e9e4da}input:focus{border-color:#eee6d7}
:focus-visible{outline:2px solid #7aa7ff;outline-offset:2px}
button,.btn{display:block;box-sizing:border-box;margin-top:12px;width:100%;height:44px;border:0;border-radius:8px;background:#eee6d7;color:#1f2639;font-size:15px;font-weight:700;text-align:center;line-height:44px;text-decoration:none;cursor:pointer}button:hover,.btn:hover{background:#d9d1c2}
.err{color:#ff8a80}.foot{margin-top:20px;padding-top:14px;border-top:1px solid #2a3142;font-size:12px;color:#a3a9b8;display:flex;justify-content:space-between;gap:12px}
.foot a{color:#a3a9b8;text-underline-offset:3px}.foot a:hover{color:#eee6d7}.card.wide{max-width:640px}.muted{color:#a3a9b8;font-size:12px}
.files{list-style:none;margin:16px 0 0;padding:0;max-height:60vh;overflow:auto}.files li{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;padding:10px 0;border-top:1px solid #2a3142;font-size:14px}
.decor{display:inline-flex;vertical-align:-3px;margin-right:6px;color:var(--dd,#eee6d7)}
.files a{color:#eee6d7;text-decoration:none;font-weight:600;word-break:break-word;flex:1 1 60%}.files a:hover{text-decoration:underline;text-underline-offset:3px}.files .size{color:#a3a9b8;font-size:12px;margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}.files .muted{flex-basis:100%;order:3}`;

/** The Zeiko mark (proxychat/brand/zeiko): navy tile, cream kawung petals, the amber dot. */
const MARK =
  '<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#1f2639"/><g fill="#eee6d7"><ellipse cx="21" cy="21" rx="11" ry="6.6" transform="rotate(45 21 21)"/><ellipse cx="43" cy="43" rx="11" ry="6.6" transform="rotate(45 43 43)"/><ellipse cx="43" cy="21" rx="11" ry="6.6" transform="rotate(-45 43 21)"/><ellipse cx="21" cy="43" rx="11" ry="6.6" transform="rotate(-45 21 43)"/></g><circle cx="32" cy="32" r="3.6" fill="#f0ae48"/></svg>';

export function page(
  title: string,
  body: string,
  opts: {
    status?: number;
    head?: string;
    reportUrl?: string;
    ad?: string;
    lang?: 'id' | 'en';
    reportLabel?: string;
    /** Wider card, for the list of a shared folder's files. */
    wide?: boolean;
  } = {},
): Response {
  const html = `<!doctype html><html lang="${opts.lang ?? 'id'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#10131b"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>${escapeHtml(title)} · Zeiko Drive</title>${opts.head ?? ''}<style>${STYLE}</style></head>
<body><main class="card${opts.wide ? ' wide' : ''}"><p class="brand">${MARK}Zeiko Drive</p>${body}
<div class="foot"><a href="/">zeiko.biz.id</a>${opts.reportUrl ? `<a href="${escapeHtml(opts.reportUrl)}">${escapeHtml(opts.reportLabel ?? 'Laporkan')}</a>` : ''}</div>
${opts.ad ?? ''}</main></body></html>`;
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
