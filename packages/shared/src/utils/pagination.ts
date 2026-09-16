import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants';

export function normalizePage(page?: number): number {
  const value = Number(page ?? 1);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

export function normalizePageSize(pageSize?: number): number {
  const value = Number(pageSize ?? DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(value), MAX_PAGE_SIZE);
}
