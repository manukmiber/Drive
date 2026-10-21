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

function DriveFolder() {
  const { folderId } = useParams({ from: '/app/drive/$folderId' });
  return <Drive key={folderId} folderId={folderId} />;
}

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: Landing }),
  createRoute({ getParentRoute: () => rootRoute, path: '/masuk', component: SignIn }),
  appRoute.addChildren([
    createRoute({ getParentRoute: () => appRoute, path: '/drive', component: () => <Drive key="root" /> }),
    createRoute({
      getParentRoute: () => appRoute,
      path: '/drive/$folderId',
      component: DriveFolder,
    }),
    page('/keluarga', 'Drive Keluarga'),
    page('/dibagikan', 'Dibagikan'),
    page('/terbaru', 'Terbaru'),
    page('/berbintang', 'Berbintang'),
    createRoute({ getParentRoute: () => appRoute, path: '/sampah', component: Trash }),
    page('/paket', 'Paket & tagihan'),
    createRoute({ getParentRoute: () => appRoute, path: '/pengaturan', component: Settings }),
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
