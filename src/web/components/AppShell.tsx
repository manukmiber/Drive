import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import {
  Archive,
  Brain,
  CircleUser,
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
import type { ComponentType } from 'react';
import { lang, setLang, t } from '../lib/i18n';
import { authClient } from '../lib/auth-client';
import { sendJson } from '../lib/api';
import { meQueryKey, useMe } from '../lib/session';
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
  'flex items-center gap-3 rounded-full px-4 py-2 text-sm text-[var(--fg)] hover:bg-[var(--bg-subtle)] [&.active]:bg-brand-100 [&.active]:font-medium [&.active]:text-brand-800 dark:[&.active]:bg-brand-800/40 dark:[&.active]:text-brand-100';

export function AppShell() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const links = useProductLinks();

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
  if (!me.data) return <Navigate to="/masuk" search={{ next: location.pathname }} />;

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
    <div className="flex h-full flex-col bg-[var(--bg)] md:flex-row">
      <aside className="hidden w-64 shrink-0 flex-col gap-4 border-r border-[var(--border)] p-4 md:flex">
        <Link to="/" className="px-2">
          <Logo />
        </Link>
        <NewMenu variant="sidebar" />
        <nav className="flex flex-col gap-1" aria-label={t.a11y.mainNav}>
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className={navLink}>
              <n.icon className="h-4 w-4" />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="px-4">
          <StorageMeter storage={data.storage} />
          <Link
            to="/paket"
            className="mt-3 inline-block rounded-full border border-brand-600 px-4 py-1.5 text-xs font-medium text-brand-700"
          >
            {t.storage.addSpace}
          </Link>
          <AdCard placement="explorer_sidebar" className="mt-4" />
        </div>
        <nav className="flex flex-col gap-1" aria-label={t.a11y.productsNav}>
          <p className="px-4 text-xs font-medium uppercase tracking-wide text-[var(--fg-muted)]">
            {t.products.title}
          </p>
          <Link to="/ai" className={navLink}>
            <Brain className="h-4 w-4" />
            {t.products.ai}
          </Link>
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
        <div className="mt-auto flex flex-col gap-1">
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
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-2">
          <Link to="/" className="md:hidden" aria-label={t.a11y.home}>
            <Logo />
          </Link>
          <form
            role="search"
            className="flex h-10 flex-1 items-center gap-2 rounded-full bg-[var(--bg-subtle)] px-4 text-sm focus-within:bg-[var(--card)] focus-within:ring-2 focus-within:ring-brand-500"
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
              className="w-full bg-transparent outline-none"
              placeholder={t.nav.searchPlaceholder}
              aria-label={t.nav.searchPlaceholder}
            />
          </form>
          <Bell />
          <Link
            to="/pengaturan"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-700 text-sm font-semibold text-white"
            aria-label={t.nav.settings}
          >
            {(data.user.name || data.user.email).slice(0, 1).toUpperCase()}
          </Link>
        </header>
        <BillingBanner />
        <main className="min-h-0 flex-1 overflow-auto pb-16 md:pb-0">
          <Outlet />
        </main>
      </div>

      <NewMenu variant="fab" />
      <UploadPanel />
      <ArchivePanel />
      <Toaster />
      <nav
        className="fixed inset-x-0 bottom-0 grid grid-cols-4 border-t border-[var(--border)] bg-[var(--card)] pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label={t.a11y.bottomNav}
      >
        {TABS.map((n) => (
          <Link
            key={n.to}
            to={n.to}
            className="flex flex-col items-center gap-0.5 py-2 text-[11px] text-[var(--fg-muted)] [&.active]:text-brand-700"
          >
            <n.icon className="h-5 w-5" />
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
