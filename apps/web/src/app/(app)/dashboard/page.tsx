'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { EmptyState } from '../../../components/ui/EmptyState';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { StatCard } from '../../../components/ui/StatCard';
import { Tag } from '../../../components/ui/Tag';
import { aiApi, contentApi, publishApi, reviewsApi } from '../../../lib/api/endpoints';
import type { PublishTask } from '../../../lib/api/types';
import { formatDateTime, TASK_STATUS_LABELS, TASK_STATUS_TONES } from '../../../lib/format';
import { InboxIcon, PublishIcon, ReviewIcon, SparkleIcon, WarningIcon } from '../../../lib/icons';
import { PLATFORM_LABELS, PlatformCode, PublishTaskStatus } from '@mediaflow/shared';
import { PlusIcon } from '../../../lib/icons';
import styles from './page.module.css';

export default function DashboardPage() {
  const contents = useQuery({ queryKey: ['contents', 'count'], queryFn: () => contentApi.list({ pageSize: 1 }) });
  const pending = useQuery({
    queryKey: ['tasks', 'count', PublishTaskStatus.Pending],
    queryFn: () => publishApi.tasks({ status: PublishTaskStatus.Pending, pageSize: 1 }),
  });
  const published = useQuery({
    queryKey: ['tasks', 'count', PublishTaskStatus.Published],
    queryFn: () => publishApi.tasks({ status: PublishTaskStatus.Published, pageSize: 1 }),
  });
  const manual = useQuery({
    queryKey: ['tasks', 'count', PublishTaskStatus.ManualRequired],
    queryFn: () => publishApi.tasks({ status: PublishTaskStatus.ManualRequired, pageSize: 1 }),
  });
  const failed = useQuery({
    queryKey: ['tasks', 'count', PublishTaskStatus.Failed],
    queryFn: () => publishApi.tasks({ status: PublishTaskStatus.Failed, pageSize: 1 }),
  });
  const pendingReviews = useQuery({
    queryKey: ['reviews', 'pending', 'count'],
    queryFn: () => reviewsApi.list({ status: 'pending', pageSize: 1 }),
  });
  const recent = useQuery({ queryKey: ['tasks', 'recent'], queryFn: () => publishApi.tasks({ pageSize: 6 }) });
  const queue = useQuery({ queryKey: ['queue', 'stats'], queryFn: () => publishApi.queueStats() });
  const ai = useQuery({ queryKey: ['ai', 'status'], queryFn: () => aiApi.status() });

  const columns: Array<Column<PublishTask>> = [
    {
      key: 'title',
      title: '内容',
      render: (row) => (
        <div className={styles.titleCell}>
          <Link className={styles.titleStrong} href={`/content/${row.contentId}/edit`}>
            {row.content?.title ?? row.contentId.slice(0, 8)}
          </Link>
          <span className={styles.metaRow}>
            <Tag tone="info">{PLATFORM_LABELS[row.platform as PlatformCode]}</Tag>
            <span style={{ color: 'var(--mf-color-text-tertiary)', fontSize: 'var(--mf-font-size-xs)' }}>
              尝试 {row.attempts}/{row.maxAttempts}
            </span>
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      title: '状态',
      width: '120px',
      render: (row) => <Tag tone={TASK_STATUS_TONES[row.status]}>{TASK_STATUS_LABELS[row.status]}</Tag>,
    },
    {
      key: 'time',
      title: '创建时间',
      width: '170px',
      render: (row) => <span className={styles.metaRow}>{formatDateTime(row.createdAt)}</span>,
    },
  ];

  return (
    <>
      {ai.data?.provider === 'mock' ? (
        <Banner tone="warning">
          当前 AI 提供方为离线模式（mock），生成内容为占位文本。在 .env 填入 AI_API_KEY 并把 AI_PROVIDER 改为 deepseek 即可启用真实生成。
        </Banner>
      ) : null}

      <section className={styles.stats}>
        <StatCard
          label="内容总数"
          value={contents.data?.meta.total ?? '—'}
          hint="含全部状态与平台版本"
          icon={<InboxIcon />}
        />
        <StatCard
          label="待发布"
          value={pending.data?.meta.total ?? '—'}
          hint="已入队等待发布"
          icon={<PublishIcon />}
        />
        <StatCard
          label="已发布"
          value={published.data?.meta.total ?? '—'}
          hint="平台已确认发布"
          icon={<SparkleIcon />}
        />
        <StatCard
          label="待审核"
          value={pendingReviews.data?.pendingCount ?? '—'}
          hint="内容审核工作流"
          icon={<ReviewIcon />}
        />
        <StatCard
          label="需人工处理"
          value={(manual.data?.meta.total ?? 0) + (failed.data?.meta.total ?? 0)}
          hint="待人工发布 / 发布失败"
          icon={<WarningIcon />}
        />
      </section>

      <section className={styles.grid}>
        <Card
          title="最近发布任务"
          extra={
            <Link href="/content">
              <Button variant="text" size="sm">
                查看内容
              </Button>
            </Link>
          }
        >
          {recent.isLoading ? (
            <SkeletonRows rows={4} />
          ) : (
            <DataTable
              columns={columns}
              rows={recent.data?.items ?? []}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="还没有发布任务"
                  description="在内容编辑器里选择平台后即可创建第一个发布任务。"
                  icon={<PublishIcon width={22} height={22} />}
                  action={
                    <Link href="/content">
                      <Button size="sm" icon={<PlusIcon width={16} height={16} />}>
                        去内容中心
                      </Button>
                    </Link>
                  }
                />
              }
            />
          )}
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mf-space-4)' }}>
          <Card title="发布队列">
            <div className={styles.queueStats}>
              <div className={styles.queueItem}>
                <span className={styles.queueValue}>{queue.isLoading ? '…' : (queue.data?.length ?? 0)}</span>
                <span className={styles.queueLabel}>队列消息</span>
              </div>
              <div className={styles.queueItem}>
                <span className={styles.queueValue}>{queue.isLoading ? '…' : (queue.data?.pending ?? 0)}</span>
                <span className={styles.queueLabel}>未确认</span>
              </div>
              <div className={styles.queueItem}>
                <span className={styles.queueValue}>{queue.isLoading ? '…' : (queue.data?.consumers ?? 0)}</span>
                <span className={styles.queueLabel}>消费者</span>
              </div>
            </div>
          </Card>

          <Card title="AI 服务">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mf-space-3)' }}>
              <div className={styles.metaRow}>
                <Tag tone={ai.data?.provider === 'deepseek' ? 'success' : 'warning'}>
                  {ai.data?.provider ?? '未知'} 提供方
                </Tag>
                <span style={{ fontSize: 'var(--mf-font-size-xs)', color: 'var(--mf-color-text-tertiary)' }}>
                  {ai.data?.model ?? '—'}
                </span>
              </div>
              <span style={{ fontSize: 'var(--mf-font-size-sm)', color: 'var(--mf-color-text-secondary)' }}>
                每次调用都会写入 AI 调用日志，可在内容编辑器里做多平台适配与合规检查。
              </span>
            </div>
          </Card>
        </div>
      </section>
    </>
  );
}
