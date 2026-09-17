'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { EmptyState } from '../../../components/ui/EmptyState';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { ApiError } from '../../../lib/api/client';
import { knowledgeApi } from '../../../lib/api/endpoints';
import type { KnowledgeSourceGroup } from '../../../lib/api/types';
import { formatDateTime } from '../../../lib/format';
import { KnowledgeIcon } from '../../../lib/icons';
import styles from './page.module.css';

/** 按来源文件管理导入的资料：某次导入发现有问题，可以整批启用/停用/删除。 */
export function SourcesPanel({ onOpenItem }: { onOpenItem: (title: string) => void }) {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);

  const sources = useQuery({ queryKey: ['knowledge', 'sources'], queryFn: () => knowledgeApi.sources() });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['knowledge'] });
  };

  const activate = useMutation({
    mutationFn: ({ ids, isActive }: { ids: string[]; isActive: boolean }) => knowledgeApi.batchActivate(ids, isActive),
    onSuccess: (result) => {
      setFeedback({ tone: 'success', text: `已更新 ${result.updated} 条资料的启用状态` });
      refresh();
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '操作失败' }),
  });

  const remove = useMutation({
    mutationFn: (ids: string[]) => knowledgeApi.batchRemove(ids),
    onSuccess: (result) => {
      setFeedback({ tone: 'info', text: `已删除 ${result.removed} 条资料（软删除，可审计）` });
      refresh();
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '删除失败' }),
  });

  const columns: Array<Column<KnowledgeSourceGroup>> = [
    {
      key: 'file',
      title: '来源文件',
      render: (row) => (
        <div className={styles.titleCell}>
          <span className={styles.titleStrong}>{row.fileName}</span>
          <span className={styles.meta}>{row.sourceUrl}</span>
        </div>
      ),
    },
    { key: 'count', title: '资料条数', width: '110px', render: (row) => <Tag tone="default">{row.count} 条</Tag> },
    {
      key: 'active',
      title: '启用情况',
      width: '150px',
      render: (row) => (
        <span className={styles.meta}>
          {row.activeCount} 启用 / {row.count - row.activeCount} 停用
        </span>
      ),
    },
    {
      key: 'time',
      title: '最近导入',
      width: '170px',
      render: (row) => <span className={styles.meta}>{formatDateTime(row.lastCreatedAt)}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      width: '290px',
      align: 'right',
      render: (row) => (
        <div className={styles.actions}>
          <Button variant="text" size="sm" onClick={() => onOpenItem(row.fileName)}>
            查看资料
          </Button>
          <Button variant="text" size="sm" disabled={activate.isPending} onClick={() => activate.mutate({ ids: row.ids, isActive: true })}>
            整批启用
          </Button>
          <Button variant="text" size="sm" disabled={activate.isPending} onClick={() => activate.mutate({ ids: row.ids, isActive: false })}>
            整批停用
          </Button>
          <Button
            variant="text"
            size="sm"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`确定删除「${row.fileName}」导入的 ${row.count} 条资料吗？（软删除，可在审计里追溯）`)) remove.mutate(row.ids);
            }}
          >
            整批删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      {feedback ? (
        <Banner tone={feedback.tone}>
          {feedback.text}
          <button type="button" onClick={() => setFeedback(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>
            知道了
          </button>
        </Banner>
      ) : null}

      <Banner tone="info">
        <span>
          这里按<strong>来源文件</strong>把导入的资料分组。某份文档解析得不理想（切片太碎、OCR 错字多），可以整批停用或删除后重新导入，不用逐条点。
        </span>
      </Banner>

      <Card flush>
        <div style={{ padding: 'var(--mf-space-4) 0 0' }}>
          {sources.isLoading ? (
            <div style={{ padding: 'var(--mf-space-5)' }}>
              <SkeletonRows rows={3} />
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={sources.data ?? []}
              rowKey={(row) => row.sourceUrl}
              empty={
                <EmptyState
                  title="还没有通过文档导入的资料"
                  description="在「资料」页点「导入文档」，解析校对后的资料会按来源文件出现在这里。"
                  icon={<KnowledgeIcon width={22} height={22} />}
                />
              }
            />
          )}
        </div>
      </Card>
    </>
  );
}
