export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PaginatedData<T> {
  items: T[];
  meta: PageMeta;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
}

export interface SortQuery {
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}
