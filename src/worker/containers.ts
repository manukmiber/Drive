// Cloudflare Containers (Durable Object–backed). Kept out of index.ts so the Node dev shims never
// import `cloudflare:workers`; wrangler's entry point (entry.ts) re-exports these classes.
import { Container } from '@cloudflare/containers';

/** ClamAV + streaming hasher (containers/scanner). */
export class ScannerContainer extends Container {
  override defaultPort = 8080;
  override sleepAfter = '10m';
}

/** ffmpeg for long videos and very large images (containers/media). */
export class MediaContainer extends Container {
  override defaultPort = 8080;
  override sleepAfter = '5m';
}
