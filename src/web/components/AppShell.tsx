import { useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Outlet, useNavigate } from '@tanstack/react-router';
import {
  Clock,
  HardDrive,
  Home,
  LogOut,
  Search,
  Settings,
  Share2,
  Star,
  Trash2,
  Users,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { t } from '../../shared/strings.id';
import { authClient } from '../lib/auth-client';
import { meQueryKey, useMe } from '../lib/session';
import { Logo } from './Logo';
import { StorageMeter } from './StorageMeter';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const NAV: NavItem[] = [
  { to: '/drive', label: t.nav.myDrive, icon: HardDrive },
  { to: '/keluarga', label: t.nav.familyDrive, icon: Users },
  { to: '/dibagikan', label: t.nav.shared, icon: Share2 },
  { to: '/terbaru', label: t.nav.recent, icon: Clock },
  { to: '/berbintang', label: t.nav.starred, icon: Star },
  { to: '/sampah', label: t.nav.trash, icon: Trash2 },
];

const TABS: NavItem[] = [
  { to: '/terbaru', label: t.nav.home, icon: Home },
  { to: '/berbintang', label: t.nav.starred, icon: Star },
  { to: '/dibagikan', label: t.nav.shared, icon: Share2 },
  { to: '/drive', label: t.nav.files, icon: HardDrive },
];

const navLink =
  'flex items-center gap-3 rounded-full px-4 py-2 text-sm text-[var(--fg)] hover:bg-[var(--bg-subtle)] [&.active]:bg-brand-100 [&.active]:font-medium [&.active]:text-brand-800 dark:[&.active]:bg-brand-800/40 dark:[&.active]:text-brand-100';

export function AppShell() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();

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
  if (!me.data) return <Navigate to="/masuk" />;

  const data = me.data;
  const nav = NAV.filter((n) => n.to !== '/keluarga' || data.space.familyId);

  async function signOut() {
    await authClient.signOut();
    qc.setQueryData(meQueryKey, null);
    await navigate({ to: '/masuk' });
  }

  return (
    <div className="flex h-full flex-col bg-[var(--bg)] md:flex-row">
      <aside className="hidden w-64 shrink-0 flex-col gap-4 border-r border-[var(--border)] p-4 md:flex">
        <Link to="/drive" className="px-2">
          <Logo />
        </Link>
        <nav className="flex flex-col gap-1" aria-label="Navigasi utama">
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
        </div>
        <div className="mt-auto flex flex-col gap-1">
          <Link to="/pengaturan" className={navLink}>
            <Settings className="h-4 w-4" />
            {t.nav.settings}
          </Link>
          <button type="button" onClick={signOut} className={navLink}>
            <LogOut className="h-4 w-4" />
            {t.nav.signOut}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-2">
          <Link to="/drive" className="md:hidden" aria-label="Zeiko">
            <Logo />
          </Link>
          <label className="flex h-10 flex-1 items-center gap-2 rounded-full bg-[var(--bg-subtle)] px-4 text-sm">
            <Search className="h-4 w-4 text-[var(--fg-muted)]" aria-hidden="true" />
            <input
              className="w-full bg-transparent outline-none"
              placeholder={t.nav.searchPlaceholder}
              aria-label={t.nav.searchPlaceholder}
            />
          </label>
          <Link
            to="/pengaturan"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-700 text-sm font-semibold text-white"
            aria-label={t.nav.settings}
          >
            {(data.user.name || data.user.email).slice(0, 1).toUpperCase()}
          </Link>
        </header>
        <main className="min-h-0 flex-1 overflow-auto pb-16 md:pb-0">
          <Outlet />
        </main>
      </div>

      <nav
        className="fixed inset-x-0 bottom-0 grid grid-cols-4 border-t border-[var(--border)] bg-[var(--card)] pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Navigasi bawah"
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
