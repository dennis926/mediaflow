'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_LABELS, PlatformCode } from '@mediaflow/shared';
import { useState } from 'react';
import { Banner } from '../../../../components/ui/Banner';
import { Button } from '../../../../components/ui/Button';
import { Card } from '../../../../components/ui/Card';
import { DataTable, type Column } from '../../../../components/ui/DataTable';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { SkeletonRows } from '../../../../components/ui/Skeleton';
import { Tag } from '../../../../components/ui/Tag';
import { ApiError } from '../../../../lib/api/client';
import { publishApi } from '../../../../lib/api/endpoints';
import type { QueueHealth } from '../../../../lib/api/types';
import { formatDateTime } from '../../../../lib/format';
import { PublishIcon, RefreshIcon } from '../../../../lib/icons';
import styles from './page.module.css';

type StuckTask = QueueHealth['stuckTasks'][number];
type DeadLetter = QueueHealth['deadLetters'][number];

function platformName(code: string): string {
  return PLATFORM_LABELS[code as PlatformCode] ?? code;
}

/**
 * 队列运维：队列状态、卡住的任务、死信（重试次数用尽）。
 * 以前这些只能登服务器看 Redis 与日志，现在页面上就能强制重排或重试。
 */
export function QueueOpsPanel() {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);

  const health = useQuery({ queryKey: ['publish', 'queue', 'health'], queryFn: () => publishApi.queueHealth(), refetchInterval: 30_000 });

  const requeue = useMutation({
    mutationFn: (id: string) => publishApi.requeue(id),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: '已强制重排，稍后刷新看结果' });
      void queryClient.invalidateQueries({ queryKey: ['publish'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '重排失败' }),
  });

  const retry = useMutation({
    mutationFn: (id: string) => publishApi.retry(id),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: '已重新入队' });
      void queryClient.invalidateQueries({ queryKey: ['publish'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '重试失败' }),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => publishApi.cancel(id),
    onSuccess: () => {
      setFeedback({ tone: 'info', text: '任务已取消' });
      void queryClient.invalidateQueries({ queryKey: ['publish'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '取消失败' }),
  });

  const stuckColumns: Array<Column<StuckTask>> = [
    { key: 'title', title: '内容', render: (row) => <span className={styles.strong}>{row.title ?? row.id.slice(0, 8)}</span> },
    { key: 'platform', title: '平台', width: '110px', render: (row) => <Tag tone="info">{platformName(row.platform)}</Tag> },
    { key: 'status', title: '状态', width: '110px', render: (row) => <Tag tone="warning">{row.status}</Tag> },
    {
      key: 'locked',
      title: '锁定情况',
      width: '200px',
      render: (row) => (
        <span className={styles.meta}>
          {row.lockedBy ? `${row.lockedBy} · ${row.lockedMinutes} 分钟前` : '未锁定'}
        </span>
      ),
    },
    { key: 'attempts', title: '尝试', width: '90px', render: (row) => <span className={styles.meta}>{row.attempts}/{row.maxAttempts}</span> },
    {
      key: 'action',
      title: '操作',
      width: '130px',
      align: 'right',
      render: (row) => (
        <Button variant="secondary" size="sm" loading={requeue.isPending && requeue.variables === row.id} onClick={() => requeue.mutate(row.id)}>
          强制重排
        </Button>
      ),
    },
  ];

  const deadColumns: Array<Column<DeadLetter>> = [
    { key: 'title', title: '内容', render: (row) => <span className={styles.strong}>{row.title ?? row.id.slice(0, 8)}</span> },
    { key: 'platform', title: '平台', width: '110px', render: (row) => <Tag tone="info">{platformName(row.platform)}</Tag> },
    { key: 'attempts', title: '尝试', width: '90px', render: (row) => <span className={styles.meta}>{row.attempts}/{row.maxAttempts}</span> },
    { key: 'time', title: '失败时间', width: '170px', render: (row) => <span className={styles.meta}>{row.finishedAt ? formatDateTime(row.finishedAt) : '—'}</span> },
    { key: 'error', title: '失败原因', render: (row) => <span className={styles.meta}>{(row.errorMessage ?? '—').slice(0, 90)}</span> },
    {
      key: 'action',
      title: '操作',
      width: '170px',
      align: 'right',
      render: (row) => (
        <span className={styles.actions}>
          <Button variant="text" size="sm" icon={<RefreshIcon width={14} height={14} />} loading={retry.isPending && retry.variables === row.id} onClick={() => retry.mutate(row.id)}>
            重试
          </Button>
          <Button variant="text" size="sm" loading={cancel.isPending && cancel.variables === row.id} onClick={() => cancel.mutate(row.id)}>
            取消
          </Button>
        </span>
      ),
    },
  ];

  const data = health.data;

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

      {data && !data.workerEnabled ? (
        <Banner tone="warning">
          <span>发布 Worker 当前是停用状态（设置 → 发布队列），任务不会自动执行；重排后也需要先启用 Worker。</span>
        </Banner>
      ) : null}

      {health.isLoading ? (
        <Card>
          <SkeletonRows rows={3} />
        </Card>
      ) : (
        <>
          <div className={styles.opsGrid}>
            <Card>
              <span className={styles.opsLabel}>消费组</span>
              <span className={styles.opsValue}>{data?.group ?? '—'}</span>
              <span className={styles.meta}>队列 {data?.stream ?? '—'}</span>
            </Card>
            <Card>
              <span className={styles.opsLabel}>消费者</span>
              <span className={styles.opsValue}>{data?.consumers ?? 0}</span>
              <span className={styles.meta}>{data?.workerEnabled ? 'Worker 已启用' : 'Worker 已停用'}</span>
            </Card>
            <Card>
              <span className={styles.opsLabel}>队列消息</span>
              <span className={styles.opsValue}>{data?.length ?? 0}</span>
              <span className={styles.meta}>未确认 {data?.pending ?? 0}</span>
            </Card>
            <Card>
              <span className={styles.opsLabel}>卡住 / 死信</span>
              <span className={styles.opsValue}>
                {data?.stuckTasks.length ?? 0} / {data?.deadLetters.length ?? 0}
              </span>
              <span className={styles.meta}>超过 {data?.stuckMinutes ?? 15} 分钟未结束算卡住</span>
            </Card>
          </div>

          <Card>
            <div className={styles.opsHead}>
              <span className={styles.strong}>卡住的任务</span>
              <span className={styles.meta}>被 Worker 领取后长时间没结束：多为进程被重启或平台接口卡死，可强制重排</span>
            </div>
            <DataTable
              columns={stuckColumns}
              rows={data?.stuckTasks ?? []}
              rowKey={(row) => row.id}
              empty={<EmptyState title="没有卡住的任务" description="队列运行正常。" icon={<PublishIcon width={22} height={22} />} />}
            />
          </Card>

          <Card>
            <div className={styles.opsHead}>
              <span className={styles.strong}>死信（重试次数用尽）</span>
              <span className={styles.meta}>这些任务不会再自动执行：确认账号与内容没问题后可手动重试，或取消掉</span>
            </div>
            <DataTable
              columns={deadColumns}
              rows={data?.deadLetters ?? []}
              rowKey={(row) => row.id}
              empty={<EmptyState title="没有死信" description="所有失败任务都还在重试范围内。" icon={<PublishIcon width={22} height={22} />} />}
            />
          </Card>
        </>
      )}
    </>
  );
}
