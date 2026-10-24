// Queue payloads carry IDs only; consumers re-read state from D1 and must be idempotent (ADR-012).
export type ScanMessage =
  | { type: 'scan'; blobId: string }
  // A Zeiko S3 object (ADR-044): checked again against the index, so a replaced object is skipped.
  | { type: 's3_scan'; userId: string; bucket: string; key: string; blobId: string };
export type ArchiveMessage = { type: 'archive'; jobId: string };
export type CompressMessage = { type: 'compress'; jobId: string };
export type NotifyMessage =
  | { type: 'notification'; notificationId: string }
  // The recipient address travels only in the message, never stored raw in D1 (SPEC §6.8).
  | { type: 'share_email'; sendId: string; to: string }
  | { type: 'admin_alert'; text: string };
export type CleanupMessage =
  | { type: 'delete_blob'; blobId: string }
  | { type: 'rebuild_manifest'; userId: string }
  | { type: 'purge_pool'; poolId: string; dryRun: boolean }
  // Account deletion: the rest of a Zeiko S3 account, a batch per message (ADR-044).
  | { type: 's3_purge'; userId: string };

export type QueueMessage =
  ScanMessage | ArchiveMessage | CompressMessage | NotifyMessage | CleanupMessage;
