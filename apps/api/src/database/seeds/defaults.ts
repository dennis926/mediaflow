/** Deterministic ids keep the seed idempotent and make local fixtures reproducible. */
export const DEFAULT_TENANT_ID = '11111111-1111-1111-1111-111111111111';
export const DEFAULT_WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';

export const ROLE_IDS: Record<string, string> = {
  owner: '33333333-3333-3333-3333-333333333301',
  admin: '33333333-3333-3333-3333-333333333302',
  editor: '33333333-3333-3333-3333-333333333303',
  reviewer: '33333333-3333-3333-3333-333333333304',
  viewer: '33333333-3333-3333-3333-333333333305',
};

export const DEFAULT_ADMIN_ID = '44444444-4444-4444-4444-444444444401';
export const DEFAULT_ADMIN_EMAIL = 'admin@mediaflow.local';
