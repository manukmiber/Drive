// D4 (ADR-083): what the Activity panel shows, for the Worker and the app alike.

export const ACTIVITY_ACTIONS = [
  'create',
  'upload',
  'replace',
  'rename',
  'move',
  'copy',
  'trash',
  'restore',
  'delete',
  'share',
  'unshare',
  'decor',
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export interface ActivityItem {
  at: number;
  actorId: string;
  /** The actor's name, for a family's log (null for the reader themself or someone gone). */
  actorName: string | null;
  action: ActivityAction;
  nodeId: string;
  parentId: string | null;
  name: string;
  /** rename: the old name; move: the folder it left; copy: the file it came from. */
  from: string | null;
  /** rename: the new name; move: the folder it went to. */
  to: string | null;
  space: 'personal' | 'family';
}
