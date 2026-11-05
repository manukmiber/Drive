// W6 (ADR-100): a spreadsheet of a Space, edited together. The room keeps a snapshot of the sheets
// and FortuneSheet's operations after it (lib/live-doc.ts); this applies the others' operations to
// the open workbook. The room orders everything: when someone else's change arrives while this
// person's own cell edits have not been numbered yet, those edits are put back on top, so every
// copy ends with the room's order. Structural operations (rows, columns, sheets) are not put back:
// two people inserting rows at the same moment is the one case that can still differ until the file
// is opened again.
import type { Op } from '@fortune-sheet/core';
import type { WorkbookInstance } from '@fortune-sheet/react';
import { DOC_COMPACT_AFTER, type DocPerson } from '../../../shared/space-doc';
import { LiveDoc, type LiveDocIo } from '../../lib/live-doc';
import type { SheetData } from './csv';

export type SheetPhase = 'joining' | 'seeding' | 'waiting' | 'live';

type Item = { snap: SheetData[] } | { ops: Op[] };

const parse = (data: string): Item => JSON.parse(data) as Item;

/** A sheet as a snapshot: its cells as a list (`celldata`), without FortuneSheet's own grid. */
export function snapshotOf(sheets: ReadonlyArray<Record<string, unknown>>): SheetData[] {
  return sheets.map((s) => {
    const { data, ...rest } = s as { data?: Array<Array<unknown>> } & Record<string, unknown>;
    if (!data) return rest as unknown as SheetData;
    const celldata: SheetData['celldata'] = [];
    data.forEach((row, r) =>
      row?.forEach((v, c) => {
        if (v !== null && v !== undefined)
          celldata.push({ r, c, v: v as SheetData['celldata'][0]['v'] });
      }),
    );
    return { ...(rest as unknown as SheetData), celldata };
  });
}

export interface SheetCollabEvents {
  phase(p: SheetPhase): void;
  /** The sheets to open with (from the room, or the file when this person seeds). */
  start(sheets: SheetData[]): void;
  people(p: DocPerson[]): void;
  saver(on: boolean): void;
}

export class SheetCollab {
  readonly live: LiveDoc;
  phase: SheetPhase = 'joining';
  savedUpto = 0;
  book: WorkbookInstance | null = null;
  /** Operations that came before the workbook was drawn. */
  private early: Op[][] = [];
  private applying = false;
  private sinceCompact = 0;
  private started = false;

  constructor(
    io: LiveDocIo,
    node: string,
    private fromFile: SheetData[],
    private ev: SheetCollabEvents,
  ) {
    this.live = new LiveDoc(
      io,
      node,
      'sheet',
      (parts) => JSON.stringify({ ops: parts.flatMap((p) => (parse(p) as { ops: Op[] }).ops) }),
      {
        state: (s) => {
          ev.people(s.people);
          ev.saver(s.saver);
          this.sinceCompact = s.items.length;
          if (this.started) {
            // Back after a reconnect: the open workbook stays; what the room has since is applied.
            if (s.seed) this.live.seed(JSON.stringify({ snap: this.snapshot() }));
            else for (const it of s.items) if (it.seq > s.before) this.take(parse(it.data));
            return this.set('live');
          }
          if (s.items.length) {
            const [first, ...rest] = s.items.map((i) => parse(i.data));
            if (!first || !('snap' in first)) return this.set('waiting');
            ev.start(first.snap);
            for (const it of rest) if ('ops' in it) this.early.push(it.ops);
            return this.set('live');
          }
          this.set(s.seed ? 'seeding' : 'waiting');
          if (s.seed) this.seedNow();
        },
        remote: (it) => {
          this.sinceCompact++;
          const item = parse(it.data);
          if ('snap' in item) {
            if (this.phase !== 'waiting') return;
            ev.start(item.snap);
            return this.set('live');
          }
          this.take(item);
        },
        aware: () => {},
        people: (p) => ev.people(p),
        saver: () => ev.saver(true),
        seedme: () => {
          if (this.phase !== 'waiting') return;
          this.set('seeding');
          this.seedNow();
        },
      },
    );
  }

  private set(p: SheetPhase) {
    this.phase = p;
    if (p === 'live') this.started = true;
    this.ev.phase(p);
  }

  private seedNow() {
    const snap = snapshotOf(this.fromFile as unknown as Array<Record<string, unknown>>);
    this.ev.start(snap);
    this.live.seed(JSON.stringify({ snap }));
    this.set('live');
  }

  private snapshot(): SheetData[] {
    return snapshotOf(
      (this.book?.getAllSheets() ?? []) as unknown as Array<Record<string, unknown>>,
    );
  }

  /** The workbook is drawn: what came meanwhile goes in. */
  attach(book: WorkbookInstance | null) {
    this.book = book;
    if (!book) return;
    const early = this.early;
    this.early = [];
    for (const ops of early) this.apply(ops);
  }

  private apply(ops: Op[]) {
    if (!this.book || !ops.length) return;
    this.applying = true;
    try {
      this.book.applyOp(ops);
    } finally {
      this.applying = false;
    }
  }

  /** Someone else's operations, with this person's not-yet-numbered cell edits put back on top. */
  private take(item: Item) {
    if (!('ops' in item)) return;
    if (!this.book) {
      this.early.push(item.ops);
      return;
    }
    this.apply(item.ops);
    const mine = this.live
      .pending()
      .flatMap((d) => (parse(d) as { ops: Op[] }).ops)
      .filter((op) => op.op === 'replace');
    if (mine.length) this.apply(mine);
  }

  /** FortuneSheet's own report of this person's change. */
  local(ops: Op[]) {
    if (this.applying || this.phase !== 'live' || !ops.length) return;
    this.live.change(JSON.stringify({ ops }));
  }

  join() {
    this.live.join();
  }

  leave() {
    this.live.leave();
  }

  get unsaved(): boolean {
    return this.live.last > this.savedUpto || !this.live.settled;
  }

  wrote(upto: number) {
    this.savedUpto = Math.max(this.savedUpto, upto);
    this.live.saved(upto);
    if (this.sinceCompact > DOC_COMPACT_AFTER && this.live.settled && upto === this.live.last) {
      this.live.compact(upto, JSON.stringify({ snap: this.snapshot() }));
      this.sinceCompact = 1;
    }
  }
}
