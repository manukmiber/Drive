import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './lib/api';
import type { Catalog } from './lib/types';
import { router } from './router';
import { UploadManager } from './upload/manager';
import { initUploads } from './upload/useUploads';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true } },
});

const manager = new UploadManager({
  maxFiles: 3,
  partConcurrency: 4,
  onUploaded: (_node, parentId) => {
    void queryClient.invalidateQueries({ queryKey: ['children', parentId] });
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  },
});
initUploads(manager);
// Limits come from config (SPEC §5.2: defaults 4 parts × 3 files).
void queryClient
  .fetchQuery({ queryKey: ['catalog'], queryFn: () => api<Catalog>('/api/public/catalog') })
  .then((c) =>
    manager.configure({
      maxFiles: c.config.upload_max_parallel_files,
      partConcurrency: c.config.upload_part_concurrency,
    }),
  )
  .catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener(
    'load',
    () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined),
  );
}
