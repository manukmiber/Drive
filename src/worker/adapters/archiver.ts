// Archive builder for async jobs (SPEC §7.2, ADR-033). `container` = Container `archiver` (zstd /
// deflate ZIP from a tar the Worker streams in). `mock` (dev/tests) = the tar itself for TAR.ZST
// (uncompressed, so tests can read it) and a deflate ZIP built in the Worker.
import { zipDeflateStream, type ZipEntry } from '../lib/zip';

export type AsyncFormat = 'tar_zst' | 'zip_deflate';

export interface ArchiveBuildInput {
  jobId: string;
  format: AsyncFormat;
  level: number;
  /** Tar of the selection with its exact length. */
  tar: ReadableStream<Uint8Array>;
  tarSize: number;
  entries: ZipEntry[];
}

export interface ArchiveOutput {
  stream: ReadableStream<Uint8Array>;
  size: number;
  contentType: string;
}

export interface Archiver {
  readonly name: 'container' | 'mock' | 'none';
  build(input: ArchiveBuildInput): Promise<ArchiveOutput>;
}

export class ContainerArchiver implements Archiver {
  readonly name = 'container';
  constructor(private ns: DurableObjectNamespace) {}

  async build(i: ArchiveBuildInput): Promise<ArchiveOutput> {
    // One instance per job: the output is spooled to that container's disk.
    const stub = this.ns.get(this.ns.idFromName(`archive-${i.jobId}`));
    const res = await stub.fetch(`http://archiver/build?format=${i.format}&level=${i.level}`, {
      method: 'POST',
      headers: { 'content-length': String(i.tarSize) },
      body: i.tar,
    });
    if (!res.ok || !res.body)
      throw new Error(`archiver ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return {
      stream: res.body,
      size: Number(res.headers.get('content-length')),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}

export class MockArchiver implements Archiver {
  readonly name = 'mock';
  constructor(private bucket: R2Bucket) {}

  async build(i: ArchiveBuildInput): Promise<ArchiveOutput> {
    if (i.format === 'tar_zst')
      return { stream: i.tar, size: i.tarSize, contentType: 'application/zstd' };
    await i.tar.cancel();
    const bytes = new Uint8Array(
      await new Response(zipDeflateStream(this.bucket, i.entries)).arrayBuffer(),
    );
    return {
      stream: new Response(bytes).body!,
      size: bytes.length,
      contentType: 'application/zip',
    };
  }
}

/** Production without the container: async formats are unavailable (the UI hides them). */
export class NoArchiver implements Archiver {
  readonly name = 'none';
  build(): Promise<ArchiveOutput> {
    return Promise.reject(new Error('archiver container not deployed'));
  }
}
