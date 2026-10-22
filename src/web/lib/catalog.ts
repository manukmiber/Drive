// Public catalog + client-safe config (plans, packs, feature flags), cached for the session.
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Catalog } from './types';

export const useCatalog = () =>
  useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<Catalog>('/api/public/catalog'),
    staleTime: 10 * 60_000,
  });
