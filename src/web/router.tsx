import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useParams,
} from '@tanstack/react-router';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { NotFound } from './pages/NotFound';

// The app lives at the root of its own address, drive.zeiko.biz.id (ADR-038); its landing page,
// prices and description are the website's (zeiko.biz.id/drive). Every page loads on demand, so the first visit only
// downloads what it needs (Lighthouse mobile, SPEC §15 Fase 12).
// `any` is React's own default for ComponentType; the real props come from M[K].
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

/** React.lazy for a named export (route components render inside the router's Suspense). */
function page<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
): LazyExoticComponent<M[K] & AnyComponent> {
  return lazy(async () => ({ default: (await load())[name] as M[K] & AnyComponent }));
}

const SignIn = page(() => import('./pages/SignIn'), 'SignIn');
const AppShell = page(() => import('./components/AppShell'), 'AppShell');
const Drive = page(() => import('./pages/Drive'), 'Drive');
const Trash = page(() => import('./pages/Trash'), 'Trash');
const Recent = page(() => import('./pages/Lists'), 'Recent');
const Search = page(() => import('./pages/Lists'), 'Search');
const Shared = page(() => import('./pages/Lists'), 'Shared');
const Starred = page(() => import('./pages/Lists'), 'Starred');
const Billing = page(() => import('./pages/Billing'), 'Billing');
const Report = page(() => import('./pages/Report'), 'Report');
const Legal = page(() => import('./pages/Legal'), 'Legal');
const FamilyPage = page(() => import('./pages/Family'), 'FamilyPage');
const JoinFamily = page(() => import('./pages/Family'), 'JoinFamily');
const Settings = page(() => import('./pages/Settings'), 'Settings');
const ApiDocs = page(() => import('./pages/ApiDocs'), 'ApiDocs');
const OAuthAuthorize = page(() => import('./pages/OAuthAuthorize'), 'OAuthAuthorize');
const Compress = page(() => import('./pages/Compress'), 'Compress');
const Advertiser = page(() => import('./pages/Advertiser'), 'Advertiser');
const Downloads = page(() => import('./pages/Downloads'), 'Downloads');
const AiDecision = page(() => import('./pages/AiDecision'), 'AiDecision');
const S3Page = page(() => import('./pages/S3'), 'S3');
const Tools = page(() => import('./pages/Tools'), 'Tools');

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
  createRoute({ getParentRoute: () => rootRoute, path: '/masuk', component: SignIn }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/oauth/authorize',
    component: OAuthAuthorize,
  }),
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
    // Storage is what the app opens on.
    createRoute({
      getParentRoute: () => appRoute,
      path: '/',
      component: () => <Drive key="root" />,
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: '/drive',
      component: () => <Drive key="root" />,
    }),
    createRoute({ getParentRoute: () => appRoute, path: '/ai', component: AiDecision }),
    createRoute({ getParentRoute: () => appRoute, path: '/s3', component: S3Page }),
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
    // Invoices are not shown any more (ADR-041); links in older emails land on Paket.
    createRoute({
      getParentRoute: () => appRoute,
      path: '/paket/invoice/$id',
      beforeLoad: () => {
        throw redirect({ to: '/paket' });
      },
    }),
    createRoute({ getParentRoute: () => appRoute, path: '/kompres', component: Compress }),
    createRoute({ getParentRoute: () => appRoute, path: '/alat', component: Tools }),
    createRoute({ getParentRoute: () => appRoute, path: '/iklan', component: Advertiser }),
    createRoute({ getParentRoute: () => appRoute, path: '/unduhan', component: Downloads }),
    createRoute({ getParentRoute: () => appRoute, path: '/pengaturan', component: Settings }),
    createRoute({ getParentRoute: () => appRoute, path: '/developer', component: ApiDocs }),
  ]),
]);

/** Where the app is served (APP_BASE_PATH on the Worker; the build is made for it). */
export const BASE_PATH = '/';

export const router = createRouter({ routeTree, basepath: BASE_PATH, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
