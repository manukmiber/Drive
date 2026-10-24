// Queue payloads carry IDs only; consumers re-read state from D1 and must be idempotent (ADR-012).
export type ScanMessage = { type: 'scan'; blobId: string };
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
  | { type: 'purge_pool'; poolId: string; dryRun: boolean };

export type QueueMessage =
  ScanMessage | ArchiveMessage | CompressMessage | NotifyMessage | CleanupMessage;
