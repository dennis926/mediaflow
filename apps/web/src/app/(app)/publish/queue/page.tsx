'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_LABELS, PlatformCode, PublishTaskStatus } from '@mediaflow/shared';
import Link from 'next/link';
import { useState } from 'react';
import { Banner } from '../../../../components/ui/Banner';
import { Button } from '../../../../components/ui/Button';
import { ManualPublishDialog } from '../../../../components/publish/ManualPublishDialog';
import { Card } from '../../../../components/ui/Card';
import { DataTable, type Column } from '../../../../components/ui/DataTable';
import { Dialog } from '../../../../components/ui/Dialog';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { QueryError } from '../../../../components/ui/QueryError';
import { Pagination } from '../../../../components/ui/Pagination';
import { SkeletonRows } from '../../../../components/ui/Skeleton';
import { Tag } from '../../../../components/ui/Tag';
import { useSiteConfig } from '../../../../lib/knowledge';
import { ApiError } from '../../../../lib/api/client';
import { publishApi } from '../../../../lib/api/endpoints';
import { QueueOpsPanel } from './QueueOpsPanel';
import type { PublishTask } from '../../../../lib/api/types';
import { TASK_STATUS_LABELS, TASK_STATUS_TONES, formatDateTime } from '../../../../lib/format';
import { PublishIcon, RefreshIcon } from '../../../../lib/icons';
import styles from './page.module.css';

const TABS: Array<{ key: string; label: string; status?: PublishTaskStatus }> = [
  { key: 'all', label: '全部' },
  { key: 'scheduled', label: '排期中', status: PublishTaskStatus.Scheduled },
  { key: 'pending', label: '待发布', status: PublishTaskStatus.Pending },
  { key: 'manual', label: '待人工发布', status: PublishTaskStatus.ManualRequired },
  { key: 'published', label: '已发布', status: PublishTaskStatus.Published },
  { key: 'failed', label: '失败', status: PublishTaskStatus.Failed },
  { key: 'canceled', label: '已取消', status: PublishTaskStatus.Canceled },
];

/** 独立的运维视图：不按状态筛选，看队列整体健康度 */
const OPS_TAB = 'ops';

const CANCELABLE: string[] = [
  PublishTaskStatus.Pending,
  PublishTaskStatus.Scheduled,
  PublishTaskStatus.Failed,
  PublishTaskStatus.ManualRequired,
];

const RETRYABLE: string[] = [
  PublishTaskStatus.Failed,
  PublishTaskStatus.ManualRequired,
  PublishTaskStatus.Canceled,
  PublishTaskStatus.Pending,
];

export default function PublishQueuePage() {
  const site = useSiteConfig();
  const queryClient = useQueryClient();
  const [active, setActive] = useState('all');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<PublishTask | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const tab = TABS.find((item) => item.key === active) ?? TABS[0];
  const tasks = useQuery({
    queryKey: ['publish', 'queue', tab.key, page],
    queryFn: () => publishApi.tasks({ status: tab.status, page, pageSize: 10 }),
  });

  const [manualTask, setManualTask] = useState<PublishTask | null>(null);

  const cancel = useMutation({
    mutationFn: (id: string) => publishApi.cancel(id),
    onSuccess: (task) => {
      setFeedback({ tone: 'info', text: '任务已取消，发布任务不会再执行' });
      setDetail(task);
      void queryClient.invalidateQueries({ queryKey: ['publish', 'queue'] });
      void queryClient.invalidateQueries({ queryKey: ['publish', 'calendar'] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '取消失败' }),
  });

  const retry = useMutation({
    mutationFn: (id: string) => publishApi.retry(id),
    onSuccess: (task) => {
      setFeedback({ tone: 'success', text: '已重新入队，稍后刷新查看结果' });
      setDetail(task);
      void queryClient.invalidateQueries({ queryKey: ['publish', 'queue'] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '重试失败' }),
  });

  const batch = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: 'cancel' | 'retry' }) => publishApi.batch(ids, action),
    onSuccess: (result, variables) => {
      const label = variables.action === 'cancel' ? '取消' : '重试';
      setFeedback({
        tone: 'info',
        text:
          result.failed.length === 0
            ? `批量${label}完成：${result.affected} 条`
            : `批量${label}：成功 ${result.affected} 条，失败 ${result.failed.length} 条（${result.failed[0].reason}）`,
      });
      setSelected([]);
      void queryClient.invalidateQueries({ queryKey: ['publish', 'queue'] });
      void queryClient.invalidateQueries({ queryKey: ['publish', 'calendar'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '批量操作失败' }),
  });

  const rows = tasks.data?.items ?? [];
  const allSelected = rows.length > 0 && rows.every((row) => selected.includes(row.id));

  const columns: Array<Column<PublishTask>> = [
    {
      key: 'select',
      title: (
        <input
          type="checkbox"
          aria-label="全选"
          checked={allSelected}
          onChange={(event) => setSelected(event.target.checked ? rows.map((row) => row.id) : [])}
        />
      ),
      width: '44px',
      render: (row) => (
        <input
          type="checkbox"
          aria-label={`选择任务 ${row.id}`}
          checked={selected.includes(row.id)}
          onChange={(event) => setSelected((prev) => (event.target.checked ? [...prev, row.id] : prev.filter((id) => id !== row.id)))}
        />
      ),
    },
    {
      key: 'content',
      title: '内容',
      render: (row) => (
        <div className={styles.titleCell}>
          <Link className={styles.titleLink} href={`/content/${row.contentId}/edit`}>
            {row.content?.title ?? row.contentId.slice(0, 8)}
          </Link>
          <span className={styles.meta}>
            <Tag tone="info">{PLATFORM_LABELS[row.platform as PlatformCode]}</Tag>
            <span>尝试 {row.attempts}/{row.maxAttempts}</span>
            <span>创建 {formatDateTime(row.createdAt)}</span>
          </span>
          {row.errorMessage ? <span className={styles.error}>{row.errorMessage}</span> : null}
        </div>
      ),
    },
    {
      key: 'status',
      title: '状态',
      width: '130px',
      render: (row) => <Tag tone={TASK_STATUS_TONES[row.status]}>{TASK_STATUS_LABELS[row.status]}</Tag>,
    },
    {
      key: 'scheduled',
      title: '排期时间',
      width: '170px',
      render: (row) => <span className={styles.meta}>{row.scheduledAt ? formatDateTime(row.scheduledAt) : '立即'}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      width: '220px',
      align: 'right',
      render: (row) => (
        <div className={styles.actions}>
          {['manual_required', 'failed', 'pending'].includes(row.status) ? (
            <Button variant="secondary" size="sm" onClick={() => setManualTask(row)}>
              人工回填
            </Button>
          ) : null}
          <Button variant="text" size="sm" onClick={() => setDetail(row)}>
            详情
          </Button>
          <Button
            variant="text"
            size="sm"
            icon={<RefreshIcon width={15} height={15} />}
            disabled={!RETRYABLE.includes(row.status)}
            loading={retry.isPending && retry.variables === row.id}
            onClick={() => retry.mutate(row.id)}
          >
            重试
          </Button>
          <Button
            variant="text"
            size="sm"
            disabled={!CANCELABLE.includes(row.status)}
            loading={cancel.isPending && cancel.variables === row.id}
            onClick={() => cancel.mutate(row.id)}
          >
            取消
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
          <button
            type="button"
            onClick={() => setFeedback(null)}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}
          >
            知道了
          </button>
        </Banner>
      ) : null}

      {selected.length > 0 ? (
        <Card>
          <div className={styles.bulkBar}>
            <span className={styles.meta}>已选 {selected.length} 条</span>
            <Button variant="secondary" size="sm" loading={batch.isPending} onClick={() => batch.mutate({ ids: selected, action: 'retry' })}>
              批量重试
            </Button>
            <Button variant="secondary" size="sm" loading={batch.isPending} onClick={() => batch.mutate({ ids: selected, action: 'cancel' })}>
              批量取消
            </Button>
            <Button variant="text" size="sm" onClick={() => setSelected([])}>
              取消选择
            </Button>
          </div>
        </Card>
      ) : null}

      <Card flush>
        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${active === OPS_TAB ? styles.tabActive : ''}`}
            onClick={() => {
              setActive(OPS_TAB);
              setPage(1);
            }}
          >
            队列运维
          </button>
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`${styles.tab} ${active === item.key ? styles.tabActive : ''}`}
              onClick={() => {
                setActive(item.key);
                setPage(1);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        {active === OPS_TAB ? (
          <div style={{ padding: 'var(--mf-space-4) var(--mf-space-5)' }}>
            <QueueOpsPanel />
          </div>
        ) : (
          <div style={{ padding: 'var(--mf-space-4) 0 0' }}>
            {tasks.isError ? (
              <QueryError error={tasks.error} action="加载发布任务" onRetry={() => void tasks.refetch()} />
            ) : tasks.isLoading ? (
            <div style={{ padding: 'var(--mf-space-5)' }}>
              <SkeletonRows rows={5} />
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={tasks.data?.items ?? []}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="该状态下暂无任务"
                  description="在内容编辑器里选择平台即可创建发布任务。"
                  icon={<PublishIcon width={22} height={22} />}
                  action={
                    <Link href="/content">
                      <Button size="sm">去内容中心</Button>
                    </Link>
                  }
                />
              }
            />
          )}
          </div>
        )}

        {active === OPS_TAB ? null : <Pagination page={page} pageSize={site.pageSize} total={tasks.data?.meta.total ?? 0} onChange={setPage} />}
      </Card>

      {/* 人工发布回填：必须是页面顶层元素。曾经误插进"任务详情"对话框的 children 里，
          导致不打开详情时点「人工回填」什么都不发生（实测截图核验时发现）。 */}
      <ManualPublishDialog open={Boolean(manualTask)} task={manualTask} onClose={() => setManualTask(null)} />

      <Dialog
        open={Boolean(detail)}
        title="任务详情"
        onClose={() => setDetail(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDetail(null)}>
              关闭
            </Button>
            <Button
              variant="secondary"
              loading={cancel.isPending}
              disabled={!detail || !CANCELABLE.includes(detail.status)}
              onClick={() => detail && cancel.mutate(detail.id)}
            >
              取消任务
            </Button>
            <Button
              loading={retry.isPending}
              disabled={!detail || !RETRYABLE.includes(detail.status)}
              icon={<RefreshIcon width={16} height={16} />}
              onClick={() => detail && retry.mutate(detail.id)}
            >
              重试发布
            </Button>
          </>
        }
      >
      {detail ? (
          <div className={styles.detail}>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>内容</span>
              <span>{detail.content?.title ?? detail.contentId}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>平台</span>
              <span>
                {PLATFORM_LABELS[detail.platform as PlatformCode]}（{detail.publishMode}）
              </span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>状态</span>
              <Tag tone={TASK_STATUS_TONES[detail.status]}>{TASK_STATUS_LABELS[detail.status]}</Tag>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>尝试次数</span>
              <span>
                {detail.attempts}/{detail.maxAttempts}
              </span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>排期</span>
              <span>{detail.scheduledAt ? formatDateTime(detail.scheduledAt) : '立即发布'}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>开始</span>
              <span>{formatDateTime(detail.startedAt)}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>完成</span>
              <span>{formatDateTime(detail.finishedAt)}</span>
            </div>
            {detail.errorMessage ? (
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>失败原因</span>
                <span className={styles.error}>{detail.errorMessage}</span>
              </div>
            ) : null}
            {typeof detail.extra?.manualMessage === 'string' ? (
              <Banner tone="warning">
                <span>{String(detail.extra.manualMessage)}</span>
              </Banner>
            ) : null}
            {detail.platformUrl ? (
              <a href={detail.platformUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--mf-color-text-link)' }}>
                {detail.platformUrl}
              </a>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
