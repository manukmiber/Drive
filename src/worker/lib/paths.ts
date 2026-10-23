// Where the app's own pages are (ADR-038): the SPA is at the root of Drive's own address
// (drive.zeiko.biz.id), beside the API, share links and downloads. APP_BASE_PATH can still put it
// under a path; the build must then be made for that path too (vite.config.ts `base`).
interface PathEnv {
  APP_ORIGIN: string;
  APP_BASE_PATH?: string | undefined;
}

export function basePath(env: PathEnv): string {
  return (env.APP_BASE_PATH ?? '').replace(/\/+$/, '');
}

/** `/drive` → `/drive` (or `{APP_BASE_PATH}/drive`). */
export function appPath(env: PathEnv, path: string): string {
  return `${basePath(env)}${path}`;
}

/** `/drive` → `https://drive.zeiko.biz.id/drive`, for emails and links that leave the app. */
export function appUrl(env: PathEnv, path: string): string {
  return `${env.APP_ORIGIN}${appPath(env, path)}`;
}
