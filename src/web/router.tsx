import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';
import { SignIn } from './pages/SignIn';

const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFound });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: Landing }),
  createRoute({ getParentRoute: () => rootRoute, path: '/masuk', component: SignIn }),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
