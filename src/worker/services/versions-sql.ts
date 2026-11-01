// D1 (ADR-084): a file's earlier contents are rows of `nodes` with kind 'version' under the file
// (status 'ready', or 'kept' when the person keeps it past the count). Their bytes count toward the
// pool like the file's own; every sum of used bytes goes through this.
export const USED_SQL = `((kind = 'file' AND status = 'ready') OR (kind = 'version' AND status IN ('ready', 'kept')))`;
