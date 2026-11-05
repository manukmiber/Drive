// Zeiko Spaces in the app (W1b, ADR-098): teams, Spaces and the people in them, from /api/teams and
// /api/spaces (ADR-095, ADR-097). The shapes mirror services/spaces.ts.
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { t } from './i18n';

export type TeamRole = 'owner' | 'admin' | 'member';
export type SpaceRole = 'admin' | 'member' | 'guest';
export type TeamStatus = 'active' | 'readonly' | 'frozen';

export interface TeamDto {
  id: string;
  name: string;
  role: TeamRole;
  status: TeamStatus;
  seats: { used: number; total: number; invited: number };
  maxSpaces: number;
  maxGuests: number;
  createdAt: number;
}

export interface SpaceDto {
  id: string;
  name: string;
  team: { id: string; name: string };
  role: SpaceRole;
  status: TeamStatus;
  createdAt: number;
}

export interface MemberDto {
  userId: string;
  name: string | null;
  email: string | null;
  role: TeamRole | SpaceRole;
  since: number;
}

export interface InviteDto {
  id: string;
  email: string;
  role: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

export interface TeamView {
  team: TeamDto;
  members: MemberDto[];
  invites: InviteDto[];
  spaces: SpaceDto[];
}

export interface SpaceView {
  space: SpaceDto;
  /** Empty for a guest: guests never see who else is there. */
  members: MemberDto[];
  invites: InviteDto[];
  /** W1e (ADR-099): the Space's files; null for a guest, rootId null until first opened. */
  files: { rootId: string | null } | null;
}

export const spacesKey = ['spaces'] as const;
export const teamKey = (id: string) => ['spaces', 'team', id] as const;
export const spaceKey = (id: string) => ['spaces', 'space', id] as const;

export const useMySpaces = (enabled = true) =>
  useQuery({
    queryKey: spacesKey,
    queryFn: () => api<{ teams: TeamDto[]; spaces: SpaceDto[] }>('/api/teams'),
    staleTime: 5 * 60_000,
    enabled,
  });

export const useTeam = (id: string) =>
  useQuery({
    queryKey: teamKey(id),
    queryFn: () => api<TeamView>(`/api/teams/${id}`),
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });

export const useSpace = (id: string) =>
  useQuery({
    queryKey: spaceKey(id),
    queryFn: () => api<SpaceView>(`/api/spaces/${id}`),
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });

/** What went wrong, in the person's words: the server's `reason` first, then its code. */
export function spaceError(e: unknown): string {
  if (!(e instanceof ApiError)) return t.errors.generic;
  const reason = typeof e.data?.reason === 'string' ? e.data.reason : null;
  const s = t.spaces.errors;
  if (reason && reason in s.reasons) return s.reasons[reason as keyof typeof s.reasons];
  if (e.code === 'READ_ONLY') return s.readOnly;
  if (e.code === 'FORBIDDEN') return s.forbidden;
  if (e.code === 'NOT_FOUND') return s.notFound;
  if (e.code === 'RATE_LIMITED') return s.rateLimited;
  if (e.code === 'VALIDATION') return s.invalid;
  return t.errors.generic;
}

/** A person's label: their name, else their email, else a placeholder. */
export const personName = (m: Pick<MemberDto, 'name' | 'email'>) =>
  m.name || m.email || t.spaces.someone;

export const initial = (name: string) => (name.trim().slice(0, 1) || '?').toUpperCase();
