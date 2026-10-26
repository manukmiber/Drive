import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initDownloads } from './download/useDownloads';
import { api } from './lib/api';
import { limitsFrom, transfer } from './lib/transfer';
import { guardTransfers } from './lib/transfer-guard';
import type { Catalog } from './lib/types';
import { router } from './router';
import { UploadManager } from './upload/manager';
import { initUploads } from './upload/useUploads';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true } },
});

// How many files move at once is the person's pick for this device (ADR-053).
const picked = transfer.get();
const manager = new UploadManager({
  maxFiles: picked.uploadFiles,
  partConcurrency: picked.uploadParts,
  onUploaded: (_node, parentId) => {
    void queryClient.invalidateQueries({ queryKey: ['children', parentId] });
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  },
});
initUploads(manager);
const downloadQueue = initDownloads(picked.downloadFiles);
transfer.subscribe(() => {
  const s = transfer.get();
  manager.configure({ maxFiles: s.uploadFiles, partConcurrency: s.uploadParts });
  downloadQueue.configure({ maxFiles: s.downloadFiles });
});
guardTransfers([manager, downloadQueue]);
// Defaults and ceilings come from config (SPEC §5.2: 4 parts × 3 files; at most 20 files, ADR-053).
void queryClient
  .fetchQuery({ queryKey: ['catalog'], queryFn: () => api<Catalog>('/api/public/catalog') })
  .then((c) => transfer.setLimits(limitsFrom(c.config)))
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
    () =>
      void navigator.serviceWorker
        .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
        .catch(() => undefined),
  );
}
