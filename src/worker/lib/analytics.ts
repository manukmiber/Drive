// Workers Analytics Engine events. Ad events must never carry a user ID (SPEC §10.7).
export type AnalyticsEvent =
  | 'download'
  | 'upload_complete'
  | 'share_download'
  | 'archive_download'
  | 'ad_impression'
  | 'ad_click'
  | 'scan_result';

export function track(
  dataset: AnalyticsEngineDataset | undefined,
  event: AnalyticsEvent,
  data: { index?: string; blobs?: string[]; doubles?: number[] },
): void {
  try {
    dataset?.writeDataPoint({
      indexes: [data.index ?? event],
      blobs: [event, ...(data.blobs ?? [])],
      doubles: data.doubles ?? [],
    });
  } catch {
    // Metrics must never break a request.
  }
}
