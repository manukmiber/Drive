// Queue payloads carry IDs only; consumers re-read state from D1 and must be idempotent (ADR-012).

/**
 * A file waiting on VirusTotal (ADR-046): where to pick up, and what our own scanner already found
 * (hashes and sniffed type, nothing about the person), so the object is not read again.
 */
export interface ScanCarry {
  n: number;
  analysisId: string | null;
  base: {
    status: 'clean' | 'skipped';
    sha256: string;
    crc32: number | null;
    sniffedMime: string | null;
    detail: string | null;
  };
}

export type ScanMessage =
  | { type: 'scan'; blobId: string; vt?: ScanCarry }
  // A Zeiko S3 object (ADR-044): checked again against the index, so a replaced object is skipped.
  | {
      type: 's3_scan';
      userId: string;
      bucket: string;
      key: string;
      blobId: string;
      vt?: ScanCarry;
    };
export type ArchiveMessage = { type: 'archive'; jobId: string };
export type CompressMessage = { type: 'compress'; jobId: string };
export type NotifyMessage =
  // A notice for the relay to keep (ADR-064), then mailed unless switched off. It carries its own
  // content: there is no D1 row to re-read.
  | {
      type: 'notice';
      id: string;
      userId: string;
      kind: string;
      payload: Record<string, unknown>;
      createdAt: number;
    }
  // Sent before ADR-064, still in the queue at the deploy: a row in the old D1 table.
  | { type: 'notification'; notificationId: string }
  // An address that unsubscribed from share emails, for the relay to keep.
  | { type: 'suppress'; emailHash: string }
  // The recipient address travels only in the message, never stored raw in D1 (SPEC §6.8).
  | { type: 'share_email'; sendId: string; to: string }
  | { type: 'admin_alert'; text: string };
export type CleanupMessage =
  | { type: 'delete_blob'; blobId: string }
  | { type: 'rebuild_manifest'; userId: string }
  | { type: 'purge_pool'; poolId: string; dryRun: boolean }
  // Account deletion: the rest of a Zeiko S3 account, a batch per message (ADR-044).
  | { type: 's3_purge'; userId: string }
  // A plan moved to 3 copies or back to 1: copies made or dropped, a batch per message (ADR-047).
  | { type: 's3_replicate'; userId: string }
  | { type: 's3_unreplicate'; userId: string };

export type QueueMessage =
  ScanMessage | ArchiveMessage | CompressMessage | NotifyMessage | CleanupMessage;
