// W6 (ADR-100): the app's side of one file edited together through its Space's live room. This
// class only speaks the room's doc frames (shared/space-doc.ts): it joins, batches what this
// person changed into one push every DOC_PUSH_EVERY_MS, keeps what was pushed but not yet taken
// (so it can go again after a reconnect), and hands the editor what others changed. The editors
// (Yjs for documents, FortuneSheet operations for spreadsheets) decide what `data` is.
import {
  DOC_PUSH_EVERY_MS,
  type DocClientFrame,
  type DocItem,
  type DocKind,
  type DocPerson,
  type DocServerFrame,
} from '../../shared/space-doc';

export interface LiveDocEvents {
  /**
   * The room's copy as it is (after joining, and again after every reconnect); `before` is the
   * last change this copy had already, so a reconnect can skip what it applied.
   */
  state(s: {
    items: DocItem[];
    seed: boolean;
    saver: boolean;
    people: DocPerson[];
    before: number;
  }): void;
  /** Someone else's change. */
  remote(item: DocItem, user: string): void;
  aware(data: string, user: string): void;
  people(people: DocPerson[]): void;
  /** This person writes the file back now. */
  saver(): void;
  /** The person asked to start the file left: this one starts it. */
  seedme(): void;
}

export interface LiveDocIo {
  send(f: DocClientFrame): boolean;
}

/** Joins changes into one push (documents: Yjs updates merged; spreadsheets: operation lists). */
export type Merge = (parts: string[]) => string;

let nonces = 0;

export class LiveDoc {
  /** The highest change this copy has (others' and own, as the room numbered them). */
  last = 0;
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Pushed, not yet numbered by the room: sent again after a reconnect. */
  readonly unacked = new Map<string, string>();
  joined = false;

  constructor(
    private io: LiveDocIo,
    readonly node: string,
    readonly kind: DocKind,
    private merge: Merge,
    private on: LiveDocEvents,
  ) {}

  join(): void {
    this.joined = this.io.send({ t: 'doc.join', node: this.node, kind: this.kind });
  }

  leave(): void {
    this.flush();
    this.io.send({ t: 'doc.leave', node: this.node });
    this.joined = false;
    if (this.timer) clearTimeout(this.timer);
  }

  seed(data: string): void {
    this.io.send({ t: 'doc.seed', node: this.node, data });
  }

  /** A change of this person's; it goes with the next push. */
  change(data: string): void {
    this.buffer.push(data);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), DOC_PUSH_EVERY_MS);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.buffer.length) return;
    const data = this.buffer.length === 1 ? this.buffer[0]! : this.merge(this.buffer);
    this.buffer = [];
    const nonce = `${Date.now().toString(36)}${(nonces++).toString(36)}`;
    this.unacked.set(nonce, data);
    this.io.send({ t: 'doc.push', node: this.node, data, nonce });
  }

  /** This person's changes the room has not numbered yet, oldest first. */
  pending(): string[] {
    return [...this.unacked.values(), ...this.buffer];
  }

  /** Nothing of this person's is waiting to reach the room. */
  get settled(): boolean {
    return !this.buffer.length && !this.unacked.size;
  }

  aware(data: string): void {
    this.io.send({ t: 'doc.aware', node: this.node, data });
  }

  saved(upto: number): void {
    this.io.send({ t: 'doc.saved', node: this.node, upto });
  }

  compact(upto: number, data: string): void {
    this.io.send({ t: 'doc.compact', node: this.node, upto, data });
  }

  /** A frame from the room; false when it was not about this file. */
  take(f: DocServerFrame): boolean {
    if (f.node !== this.node) return false;
    switch (f.t) {
      case 'doc.state': {
        const before = this.last;
        this.last = f.items.at(-1)?.seq ?? 0;
        this.on.state({ items: f.items, seed: f.seed, saver: f.saver, people: f.people, before });
        // What did not reach the room before a reconnect goes again (applying twice is harmless).
        const again = [...this.unacked.values()];
        this.unacked.clear();
        if (again.length && f.items.length) for (const d of again) this.change(d);
        return true;
      }
      case 'doc.push':
        this.last = Math.max(this.last, f.item.seq);
        this.on.remote(f.item, f.user);
        return true;
      case 'doc.ack':
        this.last = Math.max(this.last, f.seq);
        this.unacked.delete(f.nonce);
        return true;
      case 'doc.aware':
        this.on.aware(f.data, f.user);
        return true;
      case 'doc.people':
        this.on.people(f.people);
        return true;
      case 'doc.saver':
        this.on.saver();
        return true;
      case 'doc.seedme':
        this.on.seedme();
        return true;
    }
  }
}

export const isDocFrame = (f: { t: string }): f is DocServerFrame => f.t.startsWith('doc.');

/** Base64 for Yjs updates on the wire (the room keeps text). */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
