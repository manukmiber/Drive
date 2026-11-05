import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import {
  Archive,
  Brain,
  CircleUser,
  Clock,
  Database,
  HardDrive,
  Home,
  Images,
  Inbox,
  Languages,
  LayoutGrid,
  LogOut,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Minimize2,
  Moon,
  Search,
  Settings,
  Share2,
  Star,
  Sun,
  Trash2,
  Users,
  Wand2,
} from 'lucide-react';
import { useEffect, useRef, type ComponentType } from 'react';
import { lang, setLang, t } from '../lib/i18n';
import { setTheme, useTheme } from '../lib/theme';
import { authClient } from '../lib/auth-client';
import { sendJson } from '../lib/api';
import { meQueryKey, useMe } from '../lib/session';
import { useDoorSync } from '../lib/door-sync';
import { signOutOfDoor, sitePage, zeikoConfig } from '../lib/zeiko';
import { Logo } from './Logo';
import { NewMenu } from './NewMenu';
import { StorageMeter } from './StorageMeter';
import { UploadPanel } from './UploadPanel';
import { Toaster } from './ui/Toast';
import { BillingBanner } from '../pages/Billing';
import { Bell } from './Bell';
import { AdCard } from './AdCard';
import { ArchivePanel } from './ArchivePanel';
import { useCatalog } from '../lib/catalog';
import { useMySpaces } from '../lib/spaces';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const NAV: NavItem[] = [
  { to: '/', label: t.nav.myDrive, icon: HardDrive },
  { to: '/galeri', label: t.nav.gallery, icon: Images },
  { to: '/keluarga', label: t.nav.familyDrive, icon: Users },
  { to: '/dibagikan', label: t.nav.shared, icon: Share2 },
  { to: '/untuk-saya', label: t.nav.sharedWithMe, icon: Inbox },
  { to: '/terbaru', label: t.nav.recent, icon: Clock },
  { to: '/berbintang', label: t.nav.starred, icon: Star },
  { to: '/kompres', label: t.nav.compress, icon: Minimize2 },
  { to: '/alat', label: t.nav.tools, icon: Wand2 },
  { to: '/unduhan', label: t.nav.downloads, icon: Archive },
  { to: '/iklan', label: t.nav.ads, icon: Megaphone },
  { to: '/sampah', label: t.nav.trash, icon: Trash2 },
];

const TABS: NavItem[] = [
  { to: '/terbaru', label: t.nav.home, icon: Home },
  { to: '/galeri', label: t.nav.gallery, icon: Images },
  { to: '/berbintang', label: t.nav.starred, icon: Star },
  { to: '/dibagikan', label: t.nav.shared, icon: Share2 },
  { to: '/', label: t.nav.files, icon: HardDrive },
];

/** The other Zeiko products, on the same account (ADR-036). */
function useProductLinks() {
  return useQuery({
    queryKey: ['zeiko-links'],
    queryFn: async () => {
      const cfg = await zeikoConfig();
      return { account: await sitePage(''), chat: cfg.chatUrl, home: cfg.siteUrl };
    },
    staleTime: Infinity,
  });
}

/** Switch the whole UI between Indonesian and English (and tell the server, for emails). */
async function switchLang() {
  const next = lang === 'id' ? 'en' : 'id';
  await sendJson('PATCH', '/api/me', { locale: next }).catch(() => undefined);
  setLang(next);
}

// A row in the sidebar: muted until hovered, ink and bold when it is the current place.
const navLink =
  'z-nav flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]';

/** A group's name in the sidebar: sentence case, small and bold, no tracking. */
const groupLabel = 'px-3 pb-1 text-xs font-bold text-[var(--muted)]';

/** Spaces shown by name in the sidebar; the rest are one click away on /spaces. */
const SIDEBAR_SPACES = 6;

/**
 * Zeiko Spaces (T2, ADR-098): a section of its own under the person's files, with the Spaces by
 * name. Shown once Spaces are open (`capabilities.spaces`); links in emails reach /spaces anyway.
 */
function SpacesNav({ open }: { open: boolean }) {
  const q = useMySpaces(open);
  const spaces = q.data?.spaces ?? [];
  if (!open) return null;
  return (
    <nav className="flex flex-col gap-0.5" aria-label={t.nav.spaces}>
      <Link
        to="/spaces"
        activeOptions={{ exact: true }}
        className="z-nav flex min-h-8 items-center gap-2 rounded-lg px-3 text-xs font-bold text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
      >
        <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
        {t.nav.spaces}
      </Link>
      {spaces.slice(0, SIDEBAR_SPACES).map((s) => (
        <Link
          key={s.id}
          to="/spaces/$spaceId"
          params={{ spaceId: s.id }}
          className={navLink}
          title={`${s.team.name} · ${s.name}`}
        >
          <MessagesSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{s.name}</span>
        </Link>
      ))}
      {spaces.length > SIDEBAR_SPACES && (
        <Link to="/spaces" className={`${navLink} text-xs`}>
          {t.spaces.allSpaces}
        </Link>
      )}
    </nav>
  );
}

/**
 * Off to sign-in, once. `<Navigate>` navigates again every time it renders, and this shell
 * re-renders while the sign-in page is still loading (the location it reads has moved to
 * /masuk), so it would send the browser to /masuk over and over and hang the tab.
 */
function ToSignIn({ next }: { next: string }) {
  const navigate = useNavigate();
  const from = useRef(next);
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void navigate({ to: '/masuk', search: { next: from.current }, replace: true });
  }, [navigate]);
  return null;
}

export function AppShell() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const links = useProductLinks();
  const catalog = useCatalog();
  useDoorSync(
    me.data ? me.data.user.zeikoId : undefined,
    me.data ? { city: me.data.user.adCity, postalCode: me.data.user.adPostalCode } : undefined,
  );

  if (me.isPending) {
    return (
      <div
        role="status"
        className="flex h-full flex-col items-center justify-center gap-4 text-sm text-[var(--muted)]"
      >
        <Logo compact />
        {t.common.loading}
      </div>
    );
  }
  if (me.isError) {
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center text-sm"
      >
        <Logo compact />
        <p className="text-[var(--err)]">{t.errors.generic}</p>
        <button
          type="button"
          onClick={() => void me.refetch()}
          className="z-primary h-11 rounded-lg px-5 text-sm"
        >
          {t.common.retry}
        </button>
      </div>
    );
  }
  if (!me.data) return <ToSignIn next={location.pathname} />;

  const data = me.data;
  const spacesOpen = Boolean(catalog.data?.capabilities?.spaces);
  // A Space's chat fills the page down to its bottom edge.
  const fullHeight = /^\/spaces\/[0-9A-Z]{26}$/.test(location.pathname);
  const nav = NAV.filter(
    (n) =>
      (n.to !== '/keluarga' || data.space.familyId) &&
      (n.to !== '/untuk-saya' || catalog.data?.capabilities?.peopleShares),
  );

  async function signOut() {
    // Out of Zeiko Accounts too, or the next visit signs straight back in.
    await Promise.all([authClient.signOut(), signOutOfDoor()]);
    qc.setQueryData(meQueryKey, null);
    if (links.data?.home) window.location.assign(links.data.home);
    else await navigate({ to: '/masuk' });
  }

  const initial = (data.user.name || data.user.email).slice(0, 1).toUpperCase();

  return (
    <div className="z-shell flex h-full flex-col md:flex-row">
      <aside className="z-side hidden min-h-0 w-64 shrink-0 flex-col border-r border-[var(--line)] md:flex">
        <div className="flex h-16 shrink-0 items-center border-b border-[var(--line)] px-5">
          <Link to="/" aria-label={t.a11y.home} className="rounded-lg">
            <Logo />
          </Link>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-3 [&>*]:shrink-0">
          <NewMenu variant="sidebar" />
          <nav className="flex flex-col gap-0.5" aria-label={t.a11y.mainNav}>
            {nav.map((n) => (
              <Link key={n.to} to={n.to} className={navLink}>
                <n.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {n.label}
              </Link>
            ))}
          </nav>
          <SpacesNav open={spacesOpen} />
          <section
            className="border-t border-[var(--line)] px-3 pt-4"
            aria-label={t.a11y.storageUsed}
          >
            <StorageMeter storage={data.storage} />
            <div className="mt-3 flex items-center gap-3">
              <Link
                to="/paket"
                className="flex h-9 items-center rounded-lg border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--hover)]"
              >
                {t.storage.addSpace}
              </Link>
              <Link
                to="/kembar"
                className="text-xs text-[var(--muted)] underline-offset-4 hover:text-[var(--ink)] hover:underline"
              >
                {t.duplicates.find}
              </Link>
            </div>
          </section>
          <AdCard placement="explorer_sidebar" />
          <nav className="flex flex-col gap-0.5" aria-label={t.a11y.productsNav}>
            <p className={groupLabel}>{t.products.title}</p>
            <Link to="/ai" className={navLink}>
              <Brain className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t.products.ai}
            </Link>
            {catalog.data?.capabilities?.s3 && (
              <Link to="/s3" className={navLink}>
                <Database className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t.products.s3}
              </Link>
            )}
            {links.data?.chat && (
              <a href={links.data.chat} className={navLink} rel="noopener">
                <MessageCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t.products.chat}
              </a>
            )}
            {links.data?.account && (
              <a href={links.data.account} className={navLink}>
                <CircleUser className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t.products.account}
              </a>
            )}
          </nav>
          <div className="mt-auto flex flex-col gap-0.5 border-t border-[var(--line)] pt-3">
            <Link to="/pengaturan" className={navLink}>
              <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t.nav.settings}
            </Link>
            <ThemeSwitch className={navLink} />
            <button type="button" onClick={() => void switchLang()} className={navLink}>
              <Languages className="h-4 w-4 shrink-0" aria-hidden="true" />
              {lang === 'id' ? t.lang.en : t.lang.id}
            </button>
            <button type="button" onClick={signOut} className={navLink}>
              <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t.nav.signOut}
            </button>
            <p className="flex gap-4 px-3 pt-2 pb-1 text-xs text-[var(--muted)]">
              <Link
                to="/kebijakan/$slug"
                params={{ slug: 'syarat' }}
                className="underline-offset-4 hover:text-[var(--ink)] hover:underline"
              >
                {t.legal.terms}
              </Link>
              <Link
                to="/kebijakan/$slug"
                params={{ slug: 'privasi' }}
                className="underline-offset-4 hover:text-[var(--ink)] hover:underline"
              >
                {t.legal.privacy}
              </Link>
            </p>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="z-glass sticky top-0 z-20 flex h-16 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 md:gap-3 md:px-6">
          <Link to="/" className="shrink-0 rounded-lg md:hidden" aria-label={t.a11y.home}>
            <Logo compact />
          </Link>
          <form
            role="search"
            className="flex h-11 max-w-2xl min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--ground)] px-3.5 text-sm transition-colors focus-within:border-[var(--ink)] focus-within:bg-[var(--surface)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus)]"
            onSubmit={(e) => {
              e.preventDefault();
              const q = new FormData(e.currentTarget).get('q');
              if (typeof q === 'string' && q.trim())
                void navigate({ to: '/cari', search: { q: q.trim() } });
            }}
          >
            <Search className="h-4 w-4 shrink-0 text-[var(--muted)]" aria-hidden="true" />
            <input
              name="q"
              type="search"
              enterKeyHint="search"
              className="z-inner-field w-full min-w-0 bg-transparent text-base text-[var(--text)] outline-none placeholder:text-[var(--muted)] sm:text-sm"
              placeholder={t.nav.searchPlaceholder}
              aria-label={t.nav.searchPlaceholder}
            />
          </form>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {spacesOpen && (
              <Link
                to="/spaces"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] md:hidden"
                aria-label={t.nav.spaces}
              >
                <LayoutGrid className="h-5 w-5" aria-hidden="true" />
              </Link>
            )}
            <Bell />
            {/* The person's initial on the Zeiko tile, where the logo's shape stands for them. */}
            <Link
              to="/pengaturan"
              className="group flex h-11 w-11 shrink-0 items-center justify-center rounded-lg"
              aria-label={t.nav.settings}
            >
              <span className="z-tile z-tile-ink h-9 w-9 text-sm font-bold transition-colors group-hover:bg-[color-mix(in_srgb,var(--ink)_86%,var(--bg))]">
                {initial}
              </span>
            </Link>
          </div>
        </header>
        <BillingBanner />
        <main
          className={`min-h-0 flex-1 overflow-auto pb-20 ${fullHeight ? 'md:pb-0' : 'md:pb-24'}`}
        >
          <Outlet />
        </main>
      </div>

      {/* On a Space's chat the message box sits where the button would. */}
      {!fullHeight && <NewMenu variant="fab" />}
      <UploadPanel />
      <ArchivePanel />
      <Toaster />
      <nav
        className="z-glass fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-[var(--line)] pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label={t.a11y.bottomNav}
      >
        {TABS.map((n) => (
          <Link
            key={n.to}
            to={n.to}
            className="group flex min-h-14 flex-col items-center justify-center gap-0.5 pt-1.5 pb-2 text-[11px] font-semibold text-[var(--muted)] [&.active]:text-[var(--ink)]"
          >
            <span className="flex h-7 w-12 items-center justify-center rounded-lg transition-colors group-[.active]:bg-[var(--select)]">
              <n.icon className="h-5 w-5" aria-hidden="true" />
            </span>
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** Light or dark, from the sidebar (phones have it in Settings). The label names what it does. */
function ThemeSwitch({ className }: { className: string }) {
  const light = useTheme() === 'light';
  const Icon = light ? Moon : Sun;
  return (
    <button type="button" onClick={() => setTheme(light ? 'dark' : 'light')} className={className}>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {light ? t.theme.toDark : t.theme.toLight}
    </button>
  );
}
