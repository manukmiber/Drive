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
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';
import { Placeholder } from './pages/Placeholder';
import { Settings } from './pages/Settings';
import { SignIn } from './pages/SignIn';

const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFound });
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: AppShell });

const page = (path: string, title: string, note = 'Segera hadir.') =>
  createRoute({
    getParentRoute: () => appRoute,
    path,
    component: () => <Placeholder title={title} note={note} />,
  });

const reportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/lapor',
  validateSearch: (s: Record<string, unknown>): { share?: string } =>
    typeof s.share === 'string' ? { share: s.share.slice(0, 200) } : {},
  component: function ReportPage() {
    const { share } = reportRoute.useSearch();
    return <Report share={share} />;
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
    page('/keluarga', 'Drive Keluarga'),
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
