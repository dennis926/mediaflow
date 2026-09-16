'use client';

import styles from './ui.module.css';

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}

export function Pagination({ page, pageSize, total, onChange }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className={styles.pagination}>
      <span>
        共 {total} 条，当前 {from}-{to}
      </span>
      <div className={styles.paginationButtons}>
        <button type="button" className={styles.pageButton} disabled={page <= 1} onClick={() => onChange(page - 1)}>
          上一页
        </button>
        <span>
          {page} / {totalPages}
        </span>
        <button
          type="button"
          className={styles.pageButton}
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}
