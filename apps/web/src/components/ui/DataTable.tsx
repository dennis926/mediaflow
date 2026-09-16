'use client';

import type { ReactNode } from 'react';
import styles from './ui.module.css';
import { cn } from './utils';

export interface Column<T> {
  key: string;
  title: ReactNode;
  width?: string;
  align?: 'left' | 'right' | 'center';
  render: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
}

export function DataTable<T>({ columns, rows, rowKey, empty }: DataTableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>;

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                style={{ width: column.width }}
                className={cn(
                  column.align === 'right' && styles.alignRight,
                  column.align === 'center' && styles.alignCenter,
                )}
              >
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    column.align === 'right' && styles.alignRight,
                    column.align === 'center' && styles.alignCenter,
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
