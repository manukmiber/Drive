import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useParams,
} from '@tanstack/react-router';
import { AppShell } from './components/AppShell';
import { Drive } from './pages/Drive';
import { Trash } from './pages/Trash';
import { Recent, Search, Shared, Starred } from './pages/Lists';
import { Billing, InvoicePage } from './pages/Billing';
import { Admin } from './pages/Admin';
import { Report } from './pages/Report';
import { Legal } from './pages/Legal';
import { FamilyPage, JoinFamily } from './pages/Family';
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';
import { Settings } from './pages/Settings';
import { Compress } from './pages/Compress';
import { Advertiser } from './pages/Advertiser';
import { Downloads } from './pages/Downloads';
import { SignIn } from './pages/SignIn';

const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFound });
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: AppShell });

const reportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/lapor',
  validateSearch: (s: Record<string, unknown>): { share?: string; ad?: string } => ({
    ...(typeof s.share === 'string' ? { share: s.share.slice(0, 200) } : {}),
    ...(typeof s.ad === 'string' ? { ad: s.ad.slice(0, 40) } : {}),
  }),
  component: function ReportPage() {
    const { share, ad } = reportRoute.useSearch();
    return <Report share={share} ad={ad} />;
  },
});

const searchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/cari',
  validateSearch: (s: Record<string, unknown>): { q: string; type?: string } => ({
    q: typeof s.q === 'string' ? s.q.slice(0, 200) : '',
    ...(typeof s.type === 'string' ? { type: s.type } : {}),
  }),
  component: function SearchPage() {
    const { q, type } = searchRoute.useSearch();
    return <Search q={q} type={type} />;
  },
});

function DriveFolder() {
  const { folderId } = useParams({ from: '/app/drive/$folderId' });
  return <Drive key={folderId} folderId={folderId} />;
}

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: Landing }),
  createRoute({ getParentRoute: () => rootRoute, path: '/masuk', component: SignIn }),
  reportRoute,
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/keluarga/gabung/$token',
    component: function Join() {
      const { token } = useParams({ from: '/keluarga/gabung/$token' });
      return <JoinFamily token={token} />;
    },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/kebijakan/$slug',
    component: function LegalPage() {
      const { slug } = useParams({ from: '/kebijakan/$slug' });
      return <Legal slug={slug} />;
    },
  }),
  appRoute.addChildren([
    createRoute({
      getParentRoute: () => appRoute,
      path: '/drive',
      component: () => <Drive key="root" />,
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: '/drive/$folderId',
      component: DriveFolder,
    }),
    createRoute({ getParentRoute: () => appRoute, path: '/keluarga', component: FamilyPage }),
    createRoute({ getParentRoute: () => appRoute, path: '/dibagikan', component: Shared }),
    createRoute({ getParentRoute: () => appRoute, path: '/terbaru', component: Recent }),
    createRoute({ getParentRoute: () => appRoute, path: '/berbintang', component: Starred }),
    searchRoute,
    createRoute({ getParentRoute: () => appRoute, path: '/sampah', component: Trash }),
    createRoute({ getParentRoute: () => appRoute, path: '/paket', component: Billing }),
    createRoute({
      getParentRoute: () => appRoute,
      path: '/paket/invoice/$id',
      component: function Inv() {
        const { id } = useParams({ from: '/app/paket/invoice/$id' });
        return <InvoicePage id={id} />;
      },
    }),
    createRoute({ getParentRoute: () => appRoute, path: '/kompres', component: Compress }),
    createRoute({ getParentRoute: () => appRoute, path: '/iklan', component: Advertiser }),
    createRoute({ getParentRoute: () => appRoute, path: '/unduhan', component: Downloads }),
    createRoute({ getParentRoute: () => appRoute, path: '/pengaturan', component: Settings }),
    createRoute({ getParentRoute: () => appRoute, path: '/admin', component: Admin }),
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
