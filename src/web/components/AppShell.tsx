import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import {
  Archive,
  Brain,
  CircleUser,
  Database,
  Languages,
  MessageCircle,
  Clock,
  HardDrive,
  Home,
  LogOut,
  Search,
  ShieldCheck,
  Settings,
  Share2,
  Star,
  Megaphone,
  Minimize2,
  Trash2,
  Users,
} from 'lucide-react';
import { useEffect, useRef, type ComponentType } from 'react';
import { lang, setLang, t } from '../lib/i18n';
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

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const NAV: NavItem[] = [
  { to: '/', label: t.nav.myDrive, icon: HardDrive },
  { to: '/keluarga', label: t.nav.familyDrive, icon: Users },
  { to: '/dibagikan', label: t.nav.shared, icon: Share2 },
  { to: '/terbaru', label: t.nav.recent, icon: Clock },
  { to: '/berbintang', label: t.nav.starred, icon: Star },
  { to: '/kompres', label: t.nav.compress, icon: Minimize2 },
  { to: '/unduhan', label: t.nav.downloads, icon: Archive },
  { to: '/iklan', label: t.nav.ads, icon: Megaphone },
  { to: '/sampah', label: t.nav.trash, icon: Trash2 },
];

const TABS: NavItem[] = [
  { to: '/terbaru', label: t.nav.home, icon: Home },
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

const navLink =
  'z-nav flex items-center gap-3 rounded-xl px-3.5 py-2 text-sm text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]';

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
      <div className="flex h-full items-center justify-center text-[var(--fg-muted)]">
        {t.common.loading}
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="flex h-full items-center justify-center text-red-600">{t.errors.generic}</div>
    );
  }
  if (!me.data) return <ToSignIn next={location.pathname} />;

  const data = me.data;
  const nav = NAV.filter((n) => n.to !== '/keluarga' || data.space.familyId);

  async function signOut() {
    // Out of Zeiko Accounts too, or the next visit signs straight back in.
    await Promise.all([authClient.signOut(), signOutOfDoor()]);
    qc.setQueryData(meQueryKey, null);
    if (links.data?.home) window.location.assign(links.data.home);
    else await navigate({ to: '/masuk' });
  }

  return (
    <div className="z-shell flex h-full flex-col md:flex-row">
      <aside className="z-side hidden min-h-0 w-64 shrink-0 flex-col gap-5 overflow-y-auto border-r border-[var(--border)] p-4 md:flex [&>*]:shrink-0">
        <Link to="/" className="px-2 pt-1">
          <Logo />
        </Link>
        <NewMenu variant="sidebar" />
        <nav className="flex flex-col gap-0.5" aria-label={t.a11y.mainNav}>
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className={navLink}>
              <n.icon className="h-4 w-4" />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="z-card rounded-2xl p-4">
          <StorageMeter storage={data.storage} />
          <Link
            to="/paket"
            className="mt-3 flex h-9 items-center justify-center rounded-lg border border-[var(--border-strong)] text-xs font-semibold text-brand-700 transition-colors hover:bg-[var(--bg-subtle)]"
          >
            {t.storage.addSpace}
          </Link>
        </div>
        <AdCard placement="explorer_sidebar" />
        <nav className="flex flex-col gap-0.5" aria-label={t.a11y.productsNav}>
          <p className="px-3.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-muted)]">
            {t.products.title}
          </p>
          <Link to="/ai" className={navLink}>
            <Brain className="h-4 w-4" />
            {t.products.ai}
          </Link>
          {catalog.data?.capabilities?.s3 && (
            <Link to="/s3" className={navLink}>
              <Database className="h-4 w-4" />
              {t.products.s3}
            </Link>
          )}
          {links.data?.chat && (
            <a href={links.data.chat} className={navLink} rel="noopener">
              <MessageCircle className="h-4 w-4" />
              {t.products.chat}
            </a>
          )}
          {links.data?.account && (
            <a href={links.data.account} className={navLink}>
              <CircleUser className="h-4 w-4" />
              {t.products.account}
            </a>
          )}
        </nav>
        <div className="mt-auto flex flex-col gap-0.5 border-t border-[var(--border)] pt-3">
          {(data.user.role === 'admin' || data.user.role === 'moderator') && (
            <Link to="/admin" className={navLink}>
              <ShieldCheck className="h-4 w-4" />
              {t.admin.title}
            </Link>
          )}
          <Link to="/pengaturan" className={navLink}>
            <Settings className="h-4 w-4" />
            {t.nav.settings}
          </Link>
          <button type="button" onClick={() => void switchLang()} className={navLink}>
            <Languages className="h-4 w-4" />
            {lang === 'id' ? t.lang.en : t.lang.id}
          </button>
          <button type="button" onClick={signOut} className={navLink}>
            <LogOut className="h-4 w-4" />
            {t.nav.signOut}
          </button>
          <p className="flex gap-3 px-3.5 pt-2 text-[11px] text-[var(--fg-muted)]">
            <Link to="/kebijakan/$slug" params={{ slug: 'syarat' }} className="hover:underline">
              {t.legal.terms}
            </Link>
            <Link to="/kebijakan/$slug" params={{ slug: 'privasi' }} className="hover:underline">
              {t.legal.privacy}
            </Link>
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="z-glass sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-[var(--border)] px-4 md:px-6">
          <Link to="/" className="md:hidden" aria-label={t.a11y.home}>
            <Logo compact />
          </Link>
          <form
            role="search"
            className="flex h-11 max-w-2xl flex-1 items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] px-4 text-sm transition-colors focus-within:border-brand-500 focus-within:bg-[var(--card)] focus-within:ring-4 focus-within:ring-brand-500/15"
            onSubmit={(e) => {
              e.preventDefault();
              const q = new FormData(e.currentTarget).get('q');
              if (typeof q === 'string' && q.trim())
                void navigate({ to: '/cari', search: { q: q.trim() } });
            }}
          >
            <Search className="h-4 w-4 text-[var(--fg-muted)]" aria-hidden="true" />
            <input
              name="q"
              type="search"
              enterKeyHint="search"
              className="w-full bg-transparent outline-none placeholder:text-[var(--fg-muted)]"
              placeholder={t.nav.searchPlaceholder}
              aria-label={t.nav.searchPlaceholder}
            />
          </form>
          <div className="ml-auto flex items-center gap-2">
            <Bell />
            <Link
              to="/pengaturan"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-teal-500 text-sm font-semibold text-white shadow-[0_0_0_2px_var(--bg),0_0_0_3px_rgba(99,102,241,0.45)] transition-transform hover:scale-105"
              aria-label={t.nav.settings}
            >
              {(data.user.name || data.user.email).slice(0, 1).toUpperCase()}
            </Link>
          </div>
        </header>
        <BillingBanner />
        <main className="min-h-0 flex-1 overflow-auto pb-16 md:pb-24">
          <Outlet />
        </main>
      </div>

      <NewMenu variant="fab" />
      <UploadPanel />
      <ArchivePanel />
      <Toaster />
      <nav
        className="z-glass fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-[var(--border)] pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label={t.a11y.bottomNav}
      >
        {TABS.map((n) => (
          <Link
            key={n.to}
            to={n.to}
            className="group flex flex-col items-center gap-1 pt-2 pb-2.5 text-[11px] font-medium text-[var(--fg-muted)] [&.active]:text-brand-700"
          >
            <span className="flex h-7 w-14 items-center justify-center rounded-full transition-colors group-[.active]:bg-[var(--accent-soft)]">
              <n.icon className="h-5 w-5" />
            </span>
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
