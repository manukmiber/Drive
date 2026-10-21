import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { AppShell } from './components/AppShell';
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

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: Landing }),
  createRoute({ getParentRoute: () => rootRoute, path: '/masuk', component: SignIn }),
  appRoute.addChildren([
    page('/drive', 'Drive Saya', 'File explorer hadir di Fase 2.'),
    page('/keluarga', 'Drive Keluarga'),
    page('/dibagikan', 'Dibagikan'),
    page('/terbaru', 'Terbaru'),
    page('/berbintang', 'Berbintang'),
    page('/sampah', 'Sampah'),
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
