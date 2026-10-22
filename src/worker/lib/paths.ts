// Where the app's own pages are (ADR-036): the SPA lives under APP_BASE_PATH (`/dashboard` on
// zeiko.biz.id, beside the website); the API, share links and downloads stay at the root.
interface PathEnv {
  APP_ORIGIN: string;
  APP_BASE_PATH?: string | undefined;
}

export function basePath(env: PathEnv): string {
  return (env.APP_BASE_PATH ?? '/dashboard').replace(/\/+$/, '');
}

/** `/drive` → `/dashboard/drive`. */
export function appPath(env: PathEnv, path: string): string {
  return `${basePath(env)}${path}`;
}

/** `/drive` → `https://zeiko.biz.id/dashboard/drive`, for emails and links that leave the app. */
export function appUrl(env: PathEnv, path: string): string {
  return `${env.APP_ORIGIN}${appPath(env, path)}`;
}
