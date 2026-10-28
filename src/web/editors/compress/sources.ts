// Where the compressor reads from (ADR-067): a Drive file in ranges from its preview address (a
// fresh address when the old one runs out; same access and scan checks as viewing it), or a file
// from this device, read from disk as needed.
import { BlobSource, UrlSource, type Source as MediaSource } from 'mediabunny';
import { previewInfo, type NodeDto } from '../../lib/files';

export function driveMediaSource(node: NodeDto): MediaSource {
  let current: Promise<{ url: string; expiresAt: number }> | null = null;
  const fresh = () => (current = previewInfo(node.id));
  const address = async () => {
    const now = await (current ?? fresh());
    // A minute of room: a range asked for just before the end must still arrive.
    return now.expiresAt - Date.now() < 60_000 ? fresh() : now;
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const get = async () => fetch((await address()).url, { ...init, headers, credentials: 'omit' });
    const res = await get();
    if (res.status !== 410) return res;
    await fresh();
    return get();
  };
  // The first address is asked for when mediabunny first reads.
  return new UrlSource(`https://drive.invalid/${node.id}`, {
    fetchFn,
    getRetryDelay: (n) => (n < 4 ? 2 ** n : null),
  });
}

export const fileMediaSource = (blob: Blob): MediaSource => new BlobSource(blob);
