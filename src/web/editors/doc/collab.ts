// W6 (ADR-100): a document of a Space, edited together. One Yjs document per open file, kept in
// step through the Space's live room (lib/live-doc.ts); TipTap's Collaboration extension draws it
// and CollaborationCaret shows where the others are. Loaded only with the document editor.
import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { DOC_COMPACT_AFTER, type DocPerson } from '../../../shared/space-doc';
import { LiveDoc, fromBase64, toBase64, type LiveDocIo } from '../../lib/live-doc';

/** Changes that came from the room (they are not sent back). */
const REMOTE = Symbol('room');
/** Cursor moves go at most this often. */
const AWARE_EVERY_MS = 1_000;

export type DocPhase = 'joining' | 'seeding' | 'waiting' | 'live';

export interface DocCollabEvents {
  /** The phase changed; `seeding`: fill the document from the file, then call `seeded()`. */
  phase(p: DocPhase): void;
  people(p: DocPerson[]): void;
  saver(on: boolean): void;
}

/** A colour per person, steady across visits (from their id). */
export function colourOf(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 45%)`;
}

export class DocCollab {
  readonly ydoc = new Y.Doc();
  readonly awareness = new Awareness(this.ydoc);
  readonly live: LiveDoc;
  phase: DocPhase = 'joining';
  /** The room's change the file was last written with. */
  savedUpto = 0;
  private sinceCompact = 0;
  private started = false;
  private awareAt = 0;
  private awareTimer: ReturnType<typeof setTimeout> | null = null;
  private user: { name: string; color: string };

  constructor(
    io: LiveDocIo,
    node: string,
    me: { id: string; name: string },
    private ev: DocCollabEvents,
  ) {
    this.user = { name: me.name, color: colourOf(me.id) };
    this.awareness.setLocalStateField('user', this.user);
    this.live = new LiveDoc(
      io,
      node,
      'doc',
      (parts) => toBase64(Y.mergeUpdates(parts.map(fromBase64))),
      {
        state: (s) => {
          for (const it of s.items) Y.applyUpdate(this.ydoc, fromBase64(it.data), REMOTE);
          this.sinceCompact = s.items.length;
          ev.people(s.people);
          ev.saver(s.saver);
          if (this.started) {
            // Back after a reconnect: what this copy has (offline edits too) goes to the room.
            if (s.seed) this.live.seed(toBase64(Y.encodeStateAsUpdate(this.ydoc)));
            else this.live.change(toBase64(Y.encodeStateAsUpdate(this.ydoc)));
            return this.set('live');
          }
          this.set(s.items.length ? 'live' : s.seed ? 'seeding' : 'waiting');
        },
        remote: (it) => {
          Y.applyUpdate(this.ydoc, fromBase64(it.data), REMOTE);
          this.sinceCompact++;
          if (this.phase === 'waiting') this.set('live');
        },
        aware: (d) => applyAwarenessUpdate(this.awareness, fromBase64(d), REMOTE),
        people: (p) => ev.people(p),
        saver: () => ev.saver(true),
        seedme: () => {
          if (this.phase === 'waiting') this.set('seeding');
        },
      },
    );
    this.ydoc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || this.phase !== 'live') return;
      this.live.change(toBase64(u));
    });
    this.awareness.on('update', (_: unknown, origin: unknown) => {
      if (origin !== REMOTE) this.shareCursor();
    });
  }

  private set(p: DocPhase) {
    this.phase = p;
    if (p === 'live') this.started = true;
    this.ev.phase(p);
  }

  private shareCursor() {
    if (this.awareTimer) return;
    const wait = Math.max(0, this.awareAt + AWARE_EVERY_MS - Date.now());
    this.awareTimer = setTimeout(() => {
      this.awareTimer = null;
      this.awareAt = Date.now();
      if (this.phase === 'live')
        this.live.aware(toBase64(encodeAwarenessUpdate(this.awareness, [this.ydoc.clientID])));
    }, wait);
  }

  join() {
    // Back in the room: this cursor is shown again.
    this.awareness.setLocalStateField('user', this.awareness.getLocalState()?.user ?? this.user);
    this.live.join();
  }

  /** The editor filled the document from the file: that is where everyone starts. */
  seeded() {
    this.live.seed(toBase64(Y.encodeStateAsUpdate(this.ydoc)));
    this.set('live');
  }

  /** The room has changes the file does not have yet. */
  get unsaved(): boolean {
    return this.live.last > this.savedUpto || !this.live.settled;
  }

  /** After the file was written with everything up to `upto`: tell the room, and keep it small. */
  wrote(upto: number) {
    this.savedUpto = Math.max(this.savedUpto, upto);
    this.live.saved(upto);
    if (this.sinceCompact > DOC_COMPACT_AFTER && this.live.settled && upto === this.live.last) {
      this.live.compact(upto, toBase64(Y.encodeStateAsUpdate(this.ydoc)));
      this.sinceCompact = 1;
    }
  }

  /** Out of the room (closing, or the connection went): the others stop seeing this cursor. */
  leave() {
    if (this.awareTimer) clearTimeout(this.awareTimer);
    this.awareTimer = null;
    removeAwarenessStates(this.awareness, [this.ydoc.clientID], 'leave');
    this.live.leave();
  }
}
