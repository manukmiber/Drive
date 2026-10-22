// k6 load test for downloads (SPEC §15 Fase 12, §5.3): signed /d/ links, share links, and Range
// requests (resume / multi-connection). Run against STAGING only, never production:
//
//   k6 run -e BASE=https://staging.zeiko.biz.id -e SHARE_URL=<share link> -e FILE_URL=<signed /d/ URL> \
//          -e FILE_SIZE=<bytes> tests/load/download.js
//
// Thresholds encode the spec: no artificial throttling, so errors stay ~0 and time-to-first-byte low.
import http from 'k6/http';
import { check } from 'k6';

const SHARE_URL = __ENV.SHARE_URL;
const FILE_URL = __ENV.FILE_URL;
const FILE_SIZE = Number(__ENV.FILE_SIZE || 0);

export const options = {
  scenarios: {
    share_links: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '1m', target: 50 },
        { duration: '3m', target: 50 },
        { duration: '1m', target: 0 },
      ],
      exec: 'shareDownload',
    },
    ranged: {
      executor: 'constant-vus',
      vus: 20,
      duration: '4m',
      startTime: '30s',
      exec: 'rangedDownload',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_waiting{scenario:share_links}': ['p(95)<800'],
    'http_req_waiting{scenario:ranged}': ['p(95)<800'],
    checks: ['rate>0.99'],
  },
  // Large bodies: count bytes, don't keep them.
  discardResponseBodies: true,
};

export function shareDownload() {
  const res = http.get(SHARE_URL, { headers: { 'User-Agent': 'k6-zeiko-load' } });
  check(res, {
    'share 200': (r) => r.status === 200,
    'is attachment': (r) => (r.headers['Content-Disposition'] || '').startsWith('attachment'),
    'no ad page': (r) => !(r.headers['Content-Type'] || '').includes('text/html'),
  });
}

export function rangedDownload() {
  // Four "connections" like a download manager, each taking a quarter of the file.
  const quarter = Math.floor(FILE_SIZE / 4);
  const start = quarter * Math.floor(Math.random() * 4);
  const end = Math.min(FILE_SIZE - 1, start + quarter - 1);
  const res = http.get(FILE_URL, { headers: { Range: `bytes=${start}-${end}` } });
  check(res, {
    206: (r) => r.status === 206,
    'content-range': (r) => (r.headers['Content-Range'] || '').startsWith(`bytes ${start}-${end}/`),
  });
}
