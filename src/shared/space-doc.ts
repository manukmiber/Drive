// W6 (ADR-100): editing a Space's document or spreadsheet together, through the Space's live room
// (ADR-096). The room keeps one live copy per open file: a starting snapshot and what changed
// since, in order. It never reads the file itself: the first person to open it sends the snapshot
// (`seed`), and one person at a time (the room's `saver`) writes the file back to Drive now and
// then, then tells the room how far that copy goes. When nobody has the file open and everything
// was saved, the live copy goes; the next person starts again from the file.
//
// A document is a Yjs document (TipTap's own way to edit together): `data` is a base64 Yjs update.
// A spreadsheet is FortuneSheet's: the snapshot is its sheets as JSON, a change is a JSON list of
// its operations. Both kinds are opaque to the room.

export type DocKind = 'doc' | 'sheet';

export interface DocPerson {
  user: string;
  name: string;
}

export type DocClientFrame =
  /** Open the live copy (at most MAX_OPEN_DOCS per connection). */
  | { t: 'doc.join'; node: string; kind: DocKind }
  | { t: 'doc.leave'; node: string }
  /** The starting snapshot, from the one person the room asked (`seed: true`). */
  | { t: 'doc.seed'; node: string; data: string }
  /** Changes, batched by the app. `nonce` comes back in `doc.ack`. */
  | { t: 'doc.push'; node: string; data: string; nonce: string }
  /** Cursor and selection (Yjs awareness, base64): passed on, never kept. */
  | { t: 'doc.aware'; node: string; data: string }
  /** The saver wrote the file with everything up to `upto` in it. */
  | { t: 'doc.saved'; node: string; upto: number }
  /** The saver's whole copy as of `upto`, to stand for everything before it (keeps the room small). */
  | { t: 'doc.compact'; node: string; upto: number; data: string };

export interface DocItem {
  seq: number;
  data: string;
}

export type DocServerFrame =
  | {
      t: 'doc.state';
      node: string;
      kind: DocKind;
      /** Empty, and `seed` true: this person sends the snapshot. Empty and `seed` false: wait for it. */
      items: DocItem[];
      seed: boolean;
      /** This connection writes the file back now and then. */
      saver: boolean;
      people: DocPerson[];
    }
  | { t: 'doc.push'; node: string; item: DocItem; user: string }
  | { t: 'doc.ack'; node: string; seq: number; nonce: string }
  | { t: 'doc.aware'; node: string; data: string; user: string }
  /** This connection is the saver now (the one before left). */
  | { t: 'doc.saver'; node: string }
  | { t: 'doc.people'; node: string; people: DocPerson[] }
  /** The seed arrived late: the person who was asked to send it left; this one is asked now. */
  | { t: 'doc.seedme'; node: string };

/** Files one connection may have open together. */
export const MAX_OPEN_DOCS = 5;
/** The largest change, snapshot or compacted copy the room takes, in characters (base64 or JSON). */
export const MAX_DOC_DATA = 900_000;
/** Changes kept before the saver is asked to compact (it does so after its next save). */
export const DOC_COMPACT_AFTER = 300;
/** The app sends what changed at most this often (each push is a row the room writes). */
export const DOC_PUSH_EVERY_MS = 600;
