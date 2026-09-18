/**
 * Role code -> Chinese label mapping for the mobile shell.
 * Mirrors the backend defaults (apps/api .../auth/capabilities.ts) so the H5
 * shell stays readable without an extra round trip.
 */
export const ROLE_LABELS: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  editor: '内容编辑',
  reviewer: '审核员',
  viewer: '只读',
};

export type TagTone = 'default' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

export const ROLE_TONES: Record<string, TagTone> = {
  owner: 'brand',
  admin: 'info',
  editor: 'success',
  reviewer: 'warning',
  viewer: 'default',
};

export function roleLabel(code: string): string {
  return ROLE_LABELS[code] ?? code;
}

export function roleTone(code: string): TagTone {
  return ROLE_TONES[code] ?? 'default';
}

export const REVIEW_STATUS_LABELS: Record<string, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
  changes_requested: '要求修改',
};

export const REVIEW_STATUS_TONES: Record<string, TagTone> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  changes_requested: 'info',
};
