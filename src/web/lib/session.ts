import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api';
import type { Me } from './types';

export const meQueryKey = ['me'] as const;

export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: async () => {
      try {
        return await api<Me>('/api/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 30_000,
  });
}
