import { AuthUser } from './auth.types';

export interface RequestActor {
  id?: string | null;
  name?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Turns the authenticated user into the audit-friendly actor shape used by services. */
export function toActor(user?: AuthUser): RequestActor {
  return { id: user?.id ?? null, name: user?.displayName ?? 'system' };
}
