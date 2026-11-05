// A Space's chat (W4, ADR-098): topics on the side, the open topic's messages, and a thread beside
// it. Everything comes from the live room (lib/space-room.ts); this file only draws it and turns
// what the person does into frames.
import {
  ArrowLeft,
  Hash,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  UserRoundCheck,
  UserRoundX,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MessageDto, TopicDto } from '../../../shared/space-room';
import { cn } from '../../lib/cn';
import { locale, t } from '../../lib/i18n';
import { fromWire } from '../../lib/mentions';
import { listKey, typistsIn, type Pending, type Room, type RoomStatus } from '../../lib/space-room';
import { initial } from '../../lib/spaces';
import { Button } from '../Button';
import { Dialog } from '../ui/Dialog';
import { Menu, type MenuItem } from '../ui/Menu';
import { toast } from '../ui/Toast';
import { Composer, type Person } from './Composer';
import { useConfirm } from './Confirm';
import { MessageText } from './MessageText';

const timeFmt = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(locale, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const dayOf = (ms: number) => new Date(ms).toDateString();
/** Messages by the same person closer than this are drawn as one group. */
const GROUP_MS = 5 * 60_000;
const TYPING_SEND_MS = 3_000;
const NO_MESSAGES: MessageDto[] = [];

type Ask = ReturnType<typeof useConfirm>[0];

interface Names {
  nameOf: (id: string) => string | null;
  me: string | null;
  meName: string;
}

export function SpaceChat({
  room,
  people,
  meName,
  maxChars,
  topicId,
  onTopic,
}: {
  room: Room;
  /** Everyone the person can see in the Space (empty for guests), for names and mentions. */
  people: Person[];
  meName: string;
  maxChars: number;
  topicId: string | undefined;
  onTopic: (id: string) => void;
}) {
  const s = room.state;
  const [thread, setThread] = useState<MessageDto | null>(null);
  const [making, setMaking] = useState<{ topic: TopicDto | null } | null>(null);
  const [mobileTopics, setMobileTopics] = useState(false);
  const pendingTopic = useRef<string | null>(null);
  const [ask, confirmUi] = useConfirm();

  const topic = s.topics.find((x) => x.id === topicId) ?? s.topics[0] ?? null;
  const admin = s.role === 'admin';

  // Names: the Space's people, and whoever wrote what is loaded (guests see only those).
  const authors = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of Object.values(s.lists))
      for (const msg of l.messages)
        if (msg.author && msg.authorName) m.set(msg.author, msg.authorName);
    return m;
  }, [s.lists]);
  const names: Names = useMemo(() => {
    const byId = new Map(people.map((p) => [p.id, p.name]));
    return {
      me: s.me,
      meName,
      nameOf: (id) => (id === s.me ? meName : (byId.get(id) ?? authors.get(id) ?? null)),
    };
  }, [people, authors, s.me, meName]);
  const mentionable = useMemo(() => people.filter((p) => p.id !== s.me), [people, s.me]);

  // A topic made here opens as soon as the room has it.
  useEffect(() => {
    const n = pendingTopic.current;
    if (n && s.made[n]) {
      pendingTopic.current = null;
      onTopic(s.made[n]);
    }
  }, [s.made, onTopic]);

  // A thread belongs to its topic: another topic opened means no thread beside it.
  const openThread = thread && topic && thread.topic === topic.id ? thread : null;

  // Refusals not tied to a message are said once.
  useEffect(() => {
    if (!s.error) return;
    toast(t.spaces.chat.errors[s.error.code] ?? t.errors.generic, { tone: 'error' });
    room.dismiss();
  }, [s.error, room]);

  if (s.status !== 'open' && !s.me) return <RoomState status={s.status} onRetry={room.retry} />;

  const canChange = (x: TopicDto) => !s.readonly && (admin || x.createdBy === s.me);

  return (
    <div className="flex h-full min-h-0">
      <aside
        className={cn(
          'w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-subtle)]/40',
          mobileTopics ? 'absolute inset-y-0 left-0 z-20 flex bg-[var(--bg)] shadow-xl' : 'hidden',
          'md:static md:flex md:shadow-none',
        )}
        aria-label={t.spaces.chat.topics}
      >
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          <h2 className="flex-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--fg-muted)]">
            {t.spaces.chat.topics}
          </h2>
          {s.role !== 'guest' && !s.readonly && (
            <button
              type="button"
              onClick={() => setMaking({ topic: null })}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
              aria-label={t.spaces.chat.newTopic}
              title={t.spaces.chat.newTopic}
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setMobileTopics(false)}
            className="flex h-7 w-7 items-center justify-center rounded-lg md:hidden"
            aria-label={t.common.close}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
          {s.topics.map((x) => (
            <TopicRow
              key={x.id}
              topic={x}
              active={x.id === topic?.id}
              showGuests={s.role !== 'guest'}
              actions={
                canChange(x)
                  ? [
                      {
                        label: t.spaces.chat.renameTopic,
                        icon: Pencil,
                        onSelect: () => setMaking({ topic: x }),
                      },
                      {
                        label: x.guests ? t.spaces.chat.closeTopic : t.spaces.chat.openTopic,
                        icon: x.guests ? UserRoundX : UserRoundCheck,
                        onSelect: () =>
                          void room.send({ t: 'topic.update', id: x.id, guests: !x.guests }),
                      },
                      {
                        label: t.spaces.chat.removeTopic,
                        icon: Trash2,
                        danger: true,
                        onSelect: () =>
                          ask({
                            title: t.spaces.chat.removeTopic,
                            body: t.spaces.chat.removeTopicConfirm(x.name),
                            label: t.common.delete,
                            run: () => room.send({ t: 'topic.remove', id: x.id }),
                          }),
                      },
                    ]
                  : []
              }
              onOpen={() => {
                onTopic(x.id);
                setMobileTopics(false);
              }}
            />
          ))}
        </ul>
      </aside>

      <section className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border)] px-4">
          <button
            type="button"
            onClick={() => setMobileTopics(true)}
            className="-ml-2 flex h-8 items-center gap-1 rounded-lg px-2 text-sm font-medium md:hidden"
            aria-label={t.spaces.chat.topics}
          >
            <Hash className="h-4 w-4 text-[var(--fg-muted)]" />
            {topic?.name ?? '…'}
            {s.topics.some((x) => x.unread > 0 && x.id !== topic?.id) && (
              <span className="ml-1 h-2 w-2 rounded-full bg-brand-600" aria-hidden="true" />
            )}
          </button>
          <h2 className="hidden items-center gap-1 text-sm font-semibold md:flex">
            <Hash className="h-4 w-4 text-[var(--fg-muted)]" />
            {topic?.name}
          </h2>
          {topic?.guests && s.role !== 'guest' && (
            <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-brand-700">
              {t.spaces.chat.guestsBadge}
            </span>
          )}
          <StatusDot status={s.status} />
        </header>
        <StatusBanner status={s.status} onRetry={room.retry} />
        {topic ? (
          <Thread
            key={topic.id}
            room={room}
            topic={topic}
            root={null}
            names={names}
            people={mentionable}
            maxChars={maxChars}
            onThread={setThread}
            ask={ask}
          />
        ) : (
          <p className="p-6 text-sm text-[var(--fg-muted)]">{t.spaces.chat.noTopics}</p>
        )}
      </section>

      {openThread && topic && (
        <aside
          className="absolute inset-0 z-20 flex flex-col bg-[var(--bg)] md:static md:w-96 md:shrink-0 md:border-l md:border-[var(--border)]"
          aria-label={t.spaces.chat.thread}
        >
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
            <button
              type="button"
              onClick={() => setThread(null)}
              className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--bg-subtle)]"
              aria-label={t.common.close}
            >
              <ArrowLeft className="h-4 w-4 md:hidden" />
              <X className="hidden h-4 w-4 md:block" />
            </button>
            <h2 className="text-sm font-semibold">{t.spaces.chat.thread}</h2>
            <span className="truncate text-xs text-[var(--fg-muted)]">#{topic.name}</span>
          </header>
          <Thread
            key={openThread.id}
            room={room}
            topic={topic}
            root={openThread}
            names={names}
            people={mentionable}
            maxChars={maxChars}
            onThread={() => {}}
            ask={ask}
          />
        </aside>
      )}

      {making && (
        <TopicDialog
          key={making.topic?.id ?? 'new'}
          topic={making.topic}
          canGuests={s.role !== 'guest'}
          taken={(name, except) =>
            s.topics.some(
              (x) => x.id !== except && x.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
            )
          }
          onClose={() => setMaking(null)}
          onSave={(name, guests) => {
            const old = making.topic;
            setMaking(null);
            if (old) room.send({ t: 'topic.update', id: old.id, name });
            else pendingTopic.current = room.makeTopic(name, guests);
          }}
        />
      )}
      {confirmUi}
    </div>
  );
}

function TopicRow({
  topic,
  active,
  showGuests,
  actions,
  onOpen,
}: {
  topic: TopicDto;
  active: boolean;
  showGuests: boolean;
  actions: MenuItem[];
  onOpen: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm',
          active
            ? 'bg-[var(--accent-soft)] font-medium text-[var(--fg)]'
            : 'text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]',
          topic.unread > 0 && !active && 'font-semibold text-[var(--fg)]',
        )}
      >
        <Hash className="h-3.5 w-3.5 shrink-0 opacity-60" />
        <span className="min-w-0 flex-1 truncate">{topic.name}</span>
        {showGuests && topic.guests && (
          <UserRoundCheck
            className="h-3.5 w-3.5 shrink-0 opacity-50"
            aria-label={t.spaces.chat.guestsBadge}
          />
        )}
        {topic.unread > 0 && !active && (
          <span className="min-w-5 rounded-full bg-brand-600 px-1.5 text-center text-[11px] font-semibold text-white">
            {topic.unread > 99 ? '99+' : topic.unread}
          </span>
        )}
      </button>
      {actions.length > 0 && (
        <button
          type="button"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4 });
          }}
          className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-md text-[var(--fg-muted)] opacity-0 hover:bg-[var(--card)] group-hover:opacity-100 focus:opacity-100 max-md:opacity-100"
          aria-label={t.spaces.chat.messageActions}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      )}
      {menu && <Menu x={menu.x} y={menu.y} items={actions} onClose={() => setMenu(null)} />}
    </li>
  );
}

/** A topic's messages (root null) or one thread's replies under its first message. */
function Thread({
  room,
  topic,
  root,
  names,
  people,
  maxChars,
  onThread,
  ask,
}: {
  room: Room;
  topic: TopicDto;
  root: MessageDto | null;
  names: Names;
  people: Person[];
  maxChars: number;
  onThread: (m: MessageDto) => void;
  ask: Ask;
}) {
  const s = room.state;
  const key = listKey(topic.id, root?.id ?? null);
  const list = s.lists[key];
  const scroller = useRef<HTMLDivElement>(null);
  const keepFrom = useRef<number | null>(null);
  const nearBottom = useRef(true);
  const lastTyping = useRef(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The root as it is now (its text may have changed since the thread opened).
  const liveRoot = root
    ? (s.lists[topic.id]?.messages.find((m) => m.id === root.id) ?? root)
    : null;

  useEffect(() => {
    if (s.status === 'open' && !list) room.loadHistory(topic.id, root?.id ?? null);
  }, [s.status, list, room, topic.id, root?.id]);

  // Read up to the newest message while the topic is open and the tab is seen.
  useEffect(() => {
    if (root || !list || s.status !== 'open' || topic.unread === 0) return;
    if (document.visibilityState !== 'visible') return;
    room.markRead(topic.id, topic.last);
  }, [root, list, s.status, topic.unread, topic.last, topic.id, room]);
  useEffect(() => {
    if (root) return;
    const seen = () => {
      if (document.visibilityState === 'visible' && topic.unread > 0)
        room.markRead(topic.id, topic.last);
    };
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  }, [root, topic.unread, topic.last, topic.id, room]);

  // Typing names fade on their own.
  const typists = root ? [] : typistsIn(s, topic.id, now);
  useEffect(() => {
    if (!typists.length) return;
    const id = setTimeout(() => setNow(Date.now()), 1_000);
    return () => clearTimeout(id);
  }, [typists.length, now]);

  const pending = s.pending.filter((p) => p.topic === topic.id && p.thread === (root?.id ?? null));
  const messages = list?.messages ?? NO_MESSAGES;
  // The first page is on its way: nothing to say about the topic yet.
  const loaded = list !== undefined && !(list.loading && !list.messages.length);

  // Stay at the bottom as messages come, unless the person scrolled up; keep the place when older
  // messages are put above.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keepFrom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFrom.current;
      keepFrom.current = null;
    } else if (nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending.length, messages]);

  const older = useCallback(() => {
    const el = scroller.current;
    const first = messages[0];
    if (!el || !first || list?.loading) return;
    keepFrom.current = el.scrollHeight - el.scrollTop;
    room.loadHistory(topic.id, root?.id ?? null, first.seq);
  }, [messages, list?.loading, room, topic.id, root?.id]);

  const typing = () => {
    const at = Date.now();
    if (at - lastTyping.current < TYPING_SEND_MS) return;
    lastTyping.current = at;
    room.send({ t: 'typing', topic: topic.id });
  };

  const writable = s.status === 'open' && !s.readonly;

  return (
    <>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (el.scrollTop < 40 && list?.more && !list.loading) older();
        }}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-3 md:px-4"
      >
        {liveRoot && (
          <div className="mb-3 border-b border-[var(--border)] pb-3">
            <MessageRow
              m={liveRoot}
              prev={null}
              names={names}
              room={room}
              editing={editing === liveRoot.id}
              onEdit={setEditing}
              people={people}
              maxChars={maxChars}
              ask={ask}
              inThread
            />
          </div>
        )}
        {loaded && list.more && messages.length > 0 && (
          <div className="flex justify-center py-2">
            <Button variant="ghost" onClick={older} disabled={list.loading}>
              {list.loading ? t.common.loading : t.spaces.chat.older}
            </Button>
          </div>
        )}
        {!loaded && <p className="p-4 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>}
        {loaded && !messages.length && !pending.length && (
          <p className="px-3 py-8 text-center text-sm text-[var(--fg-muted)]">
            {root ? t.spaces.chat.emptyThread : t.spaces.chat.empty}
          </p>
        )}
        {messages.map((m, i) => (
          <MessageRow
            key={m.id}
            m={m}
            prev={messages[i - 1] ?? null}
            after={liveRoot?.at}
            names={names}
            room={room}
            editing={editing === m.id}
            onEdit={setEditing}
            onThread={root ? undefined : onThread}
            people={people}
            maxChars={maxChars}
            ask={ask}
            inThread={Boolean(root)}
          />
        ))}
        {pending.map((p) => (
          <PendingRow key={p.nonce} p={p} names={names} room={room} />
        ))}
      </div>
      <div className="shrink-0 px-2 pb-2 md:px-4 md:pb-4">
        <p className="h-5 truncate px-2 text-xs text-[var(--fg-muted)]" aria-live="polite">
          {typists.length > 2
            ? t.spaces.chat.typingMany
            : typists.length
              ? t.spaces.chat.typing(typists.map((x) => x.name).join(', '))
              : ''}
        </p>
        {s.readonly ? (
          <p className="rounded-xl bg-[var(--bg-subtle)] px-4 py-3 text-sm text-[var(--fg-muted)]">
            {t.spaces.chat.readonly}
          </p>
        ) : (
          <Composer
            key={key}
            placeholder={
              root ? t.spaces.chat.replyPlaceholder : t.spaces.chat.placeholder(topic.name)
            }
            people={people}
            maxChars={maxChars}
            disabled={!writable}
            autoFocus={Boolean(root)}
            onTyping={typing}
            onSend={(wire) => {
              nearBottom.current = true;
              room.post(topic.id, wire, root?.id ?? null);
            }}
          />
        )}
        {!root && (
          <p className="mt-1 hidden px-2 text-[11px] text-[var(--fg-muted)] md:block">
            {t.spaces.chat.hint}
          </p>
        )}
      </div>
    </>
  );
}

function Avatar({ name, faded }: { name: string; faded?: boolean }) {
  return (
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800 dark:bg-brand-800/50',
        faded && 'opacity-50',
      )}
      aria-hidden="true"
    >
      {initial(name)}
    </span>
  );
}

function MessageRow({
  m,
  prev,
  names,
  room,
  editing,
  onEdit,
  onThread,
  people,
  maxChars,
  ask,
  inThread,
  after,
}: {
  m: MessageDto;
  prev: MessageDto | null;
  /** When the message above it was written, outside this list (a thread's first message). */
  after?: number;
  names: Names;
  room: Room;
  editing: boolean;
  onEdit: (id: string | null) => void;
  onThread?: (m: MessageDto) => void;
  people: Person[];
  maxChars: number;
  ask: Ask;
  inThread?: boolean;
}) {
  const s = room.state;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const gone = m.author === null;
  const name = gone
    ? t.spaces.someone
    : (names.nameOf(m.author!) ?? m.authorName ?? t.spaces.someone);
  const above = prev?.at ?? after;
  const newDay = above === undefined || dayOf(above) !== dayOf(m.at);
  const grouped =
    !newDay && prev && prev.author === m.author && m.at - prev.at < GROUP_MS && prev.text !== null;
  const mine = m.author !== null && m.author === s.me;
  const writable = s.status === 'open' && !s.readonly;

  const items: MenuItem[] = [];
  if (m.text !== null && writable) {
    if (onThread)
      items.push({
        label: t.spaces.chat.reply,
        icon: MessageSquareText,
        onSelect: () => onThread(m),
      });
    if (mine) items.push({ label: t.spaces.chat.edit, icon: Pencil, onSelect: () => onEdit(m.id) });
    if (mine || s.role === 'admin')
      items.push({
        label: t.spaces.chat.remove,
        icon: Trash2,
        danger: true,
        onSelect: () =>
          ask({
            title: t.spaces.chat.remove,
            body: t.spaces.chat.removeConfirm,
            label: t.common.delete,
            run: () => room.send({ t: 'delete', id: m.id }),
          }),
      });
  }

  const edit = editing && m.text !== null ? fromWire(m.text, names.nameOf) : null;

  return (
    <>
      {newDay && (
        <div className="my-3 flex items-center gap-3 px-2 text-[11px] font-medium text-[var(--fg-muted)]">
          <span className="h-px flex-1 bg-[var(--border)]" />
          {dayFmt.format(m.at)}
          <span className="h-px flex-1 bg-[var(--border)]" />
        </div>
      )}
      <article
        className={cn(
          'group relative flex gap-3 rounded-xl px-2 hover:bg-[var(--bg-subtle)]/60',
          grouped ? 'py-0.5' : 'mt-2 py-1',
        )}
      >
        <div className="w-8 shrink-0">
          {!grouped && <Avatar name={name} faded={gone} />}
          {grouped && (
            <time
              dateTime={new Date(m.at).toISOString()}
              className="hidden pt-0.5 text-[10px] text-[var(--fg-muted)] group-hover:block"
            >
              {timeFmt.format(m.at)}
            </time>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {!grouped && (
            <p className="flex items-baseline gap-2">
              <span className={cn('text-sm font-semibold', gone && 'text-[var(--fg-muted)]')}>
                {name}
              </span>
              <time
                dateTime={new Date(m.at).toISOString()}
                className="text-[11px] text-[var(--fg-muted)]"
              >
                {timeFmt.format(m.at)}
              </time>
            </p>
          )}
          {edit ? (
            <div className="mt-1">
              <p className="mb-1 text-[11px] font-medium text-[var(--fg-muted)]">
                {t.spaces.chat.editing}
              </p>
              <Composer
                placeholder={t.spaces.chat.edit}
                people={people}
                maxChars={maxChars}
                initialText={edit.text}
                initialPicks={edit.picks}
                editing
                autoFocus
                onCancel={() => onEdit(null)}
                onSend={(wire) => {
                  if (wire !== m.text) room.send({ t: 'edit', id: m.id, text: wire });
                  onEdit(null);
                }}
              />
            </div>
          ) : m.text === null ? (
            <p className="text-sm italic text-[var(--fg-muted)]">
              {gone ? t.spaces.chat.unavailable : t.spaces.chat.removed}
            </p>
          ) : (
            <>
              <MessageText text={m.text} nameOf={names.nameOf} me={names.me} />
              {m.editedAt && (
                <span className="text-[11px] text-[var(--fg-muted)]">({t.spaces.chat.edited})</span>
              )}
            </>
          )}
          {!inThread && onThread && m.replies > 0 && (
            <button
              type="button"
              onClick={() => onThread(m)}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-xs font-medium text-brand-700 hover:bg-[var(--accent-soft)]"
            >
              <MessageSquareText className="h-3.5 w-3.5" />
              {t.spaces.chat.replies(m.replies)}
            </button>
          )}
        </div>
        {items.length > 0 && !edit && (
          <div className="absolute -top-3 right-2 hidden items-center rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-sm group-hover:flex group-focus-within:flex max-md:flex max-md:static max-md:border-0 max-md:bg-transparent max-md:shadow-none">
            {onThread && (
              <button
                type="button"
                onClick={() => onThread(m)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--fg-muted)] hover:text-[var(--fg)] max-md:hidden"
                aria-label={t.spaces.chat.reply}
                title={t.spaces.chat.reply}
              >
                <MessageSquareText className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.right - 192, y: r.bottom + 4 });
              }}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--fg-muted)] hover:text-[var(--fg)]"
              aria-label={t.spaces.chat.messageActions}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </div>
        )}
        {menu && <Menu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      </article>
    </>
  );
}

function PendingRow({ p, names, room }: { p: Pending; names: Names; room: Room }) {
  return (
    <article className="mt-2 flex gap-3 px-2 py-1">
      <Avatar name={names.meName} faded />
      <div className="min-w-0 flex-1">
        <div className="opacity-60">
          <MessageText text={p.text} nameOf={names.nameOf} me={names.me} />
        </div>
        {p.failed ? (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-red-600">
            {p.failed === 'bad_frame' ? t.spaces.chat.failed : t.spaces.chat.errors[p.failed]}
            <button
              type="button"
              onClick={() => room.resend(p)}
              className="inline-flex items-center gap-1 font-medium underline"
            >
              <RotateCw className="h-3 w-3" /> {t.spaces.chat.resend}
            </button>
            <button
              type="button"
              onClick={() => room.discard(p.nonce)}
              className="font-medium underline"
            >
              {t.spaces.chat.discard}
            </button>
          </p>
        ) : (
          <p className="mt-0.5 text-[11px] text-[var(--fg-muted)]">{t.spaces.chat.sending}</p>
        )}
      </div>
    </article>
  );
}

/** Mounted each time it opens, so it starts from the topic it is for. */
function TopicDialog({
  topic,
  canGuests,
  taken,
  onClose,
  onSave,
}: {
  topic: TopicDto | null;
  canGuests: boolean;
  taken: (name: string, except?: string) => boolean;
  onClose: () => void;
  onSave: (name: string, guests: boolean) => void;
}) {
  const [name, setName] = useState(topic?.name ?? '');
  const [guests, setGuests] = useState(topic?.guests ?? false);
  const clean = name.replace(/^#+/, '').trim().replace(/\s+/g, ' ');
  const clash = clean !== '' && taken(clean, topic?.id);
  const ok = clean.length > 0 && clean.length <= 60 && !clash;
  return (
    <Dialog
      open
      title={topic ? t.spaces.chat.renameTopic : t.spaces.chat.newTopic}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" form="topic-form" disabled={!ok}>
            {t.common.save}
          </Button>
        </>
      }
    >
      <form
        id="topic-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onSave(clean, guests);
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--fg-muted)]">
            {t.spaces.chat.topicName}
          </span>
          <span className="flex h-10 items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 focus-within:border-brand-500">
            <Hash className="h-4 w-4 text-[var(--fg-muted)]" />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={61}
              className="h-full flex-1 bg-transparent outline-none"
              autoFocus
            />
          </span>
        </label>
        {clash && <p className="text-xs text-red-600">{t.spaces.chat.topicTaken}</p>}
        {!topic && canGuests && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={guests}
              onChange={(e) => setGuests(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-brand-600"
            />
            {t.spaces.chat.openToGuests}
          </label>
        )}
      </form>
    </Dialog>
  );
}

function StatusDot({ status }: { status: RoomStatus }) {
  if (status === 'open') return null;
  return (
    <span className="ml-auto flex items-center gap-1.5 text-xs text-[var(--fg-muted)]">
      <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
      <span className="hidden sm:inline">{t.spaces.chat.state[stateKey(status)]}</span>
    </span>
  );
}

function stateKey(s: RoomStatus): keyof typeof t.spaces.chat.state {
  return s === 'open' ? 'connecting' : s;
}

function StatusBanner({ status, onRetry }: { status: RoomStatus; onRetry: () => void }) {
  if (status === 'open' || status === 'connecting' || status === 'retrying') return null;
  return (
    <div className="flex items-center gap-3 border-b border-[var(--border)] bg-amber-500/10 px-4 py-2 text-sm">
      <span className="flex-1">{t.spaces.chat.state[stateKey(status)]}</span>
      {status === 'unavailable' && (
        <Button variant="ghost" onClick={onRetry}>
          {t.common.retry}
        </Button>
      )}
    </div>
  );
}

/** Before the room said hello: connecting, or why it will not. */
function RoomState({ status, onRetry }: { status: RoomStatus; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-[var(--fg-muted)]">{t.spaces.chat.state[stateKey(status)]}</p>
      {status === 'unavailable' && (
        <Button variant="secondary" onClick={onRetry}>
          {t.common.retry}
        </Button>
      )}
    </div>
  );
}
