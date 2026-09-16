'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_LABELS, PlatformCode } from '@mediaflow/shared';
import { useState } from 'react';
import { Banner } from '../../../../components/ui/Banner';
import { Button } from '../../../../components/ui/Button';
import { Card } from '../../../../components/ui/Card';
import { Dialog } from '../../../../components/ui/Dialog';
import { SkeletonRows } from '../../../../components/ui/Skeleton';
import { Tag } from '../../../../components/ui/Tag';
import { ApiError } from '../../../../lib/api/client';
import { publishApi } from '../../../../lib/api/endpoints';
import type { PublishTask } from '../../../../lib/api/types';
import { formatDateTime, TASK_STATUS_LABELS, TASK_STATUS_TONES } from '../../../../lib/format';
import { RefreshIcon } from '../../../../lib/icons';
import styles from './page.module.css';

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function toIsoDate(date: Date): string {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function startOfWeek(date: Date): Date {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = (local.getDay() + 6) % 7;
  local.setDate(local.getDate() - weekday);
  return local;
}

export default function PublishCalendarPage() {
  const queryClient = useQueryClient();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [detail, setDetail] = useState<PublishTask | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const calendar = useQuery({
    queryKey: ['publish', 'calendar', toIsoDate(weekStart)],
    queryFn: () => publishApi.calendar(toIsoDate(weekStart)),
  });

  const retry = useMutation({
    mutationFn: (id: string) => publishApi.retry(id),
    onSuccess: () => {
      setFeedback('已重新入队');
      setDetail(null);
      void queryClient.invalidateQueries({ queryKey: ['publish', 'calendar'] });
    },
    onError: (error: unknown) => setFeedback(error instanceof ApiError ? error.message : '重试失败'),
  });

  const shiftWeek = (days: number): void => {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + days);
    setWeekStart(startOfWeek(next));
  };

  const today = toIsoDate(new Date());
  const endOfWeek = new Date(weekStart);
  endOfWeek.setDate(endOfWeek.getDate() + 6);

  return (
    <>
      {feedback ? <Banner tone="info">{feedback}</Banner> : null}

      <Card
        title="排期日历"
        extra={
          <div className={styles.toolbar}>
            <Button size="sm" variant="secondary" onClick={() => shiftWeek(-7)}>
              上一周
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setWeekStart(startOfWeek(new Date()))}>
              本周
            </Button>
            <Button size="sm" variant="secondary" onClick={() => shiftWeek(7)}>
              下一周
            </Button>
          </div>
        }
      >
        <div className={styles.weekLabel} style={{ marginBottom: 'var(--mf-space-3)' }}>
          {toIsoDate(weekStart)} ~ {toIsoDate(endOfWeek)}
        </div>

        {calendar.isLoading ? (
          <SkeletonRows rows={5} />
        ) : (
          <div className={styles.grid}>
            {(calendar.data ?? []).map((day, index) => (
              <div key={day.date} className={`${styles.day} ${day.date === today ? styles.dayToday : ''}`}>
                <div className={styles.dayHeader}>
                  <span>{WEEKDAYS[index]}</span>
                  <span className={styles.dayNumber}>{day.date.slice(8)}</span>
                </div>
                {day.tasks.length === 0 ? (
                  <span className={styles.empty}>无排期</span>
                ) : (
                  day.tasks.map((task) => (
                    <button
                      type="button"
                      key={task.id}
                      className={styles.taskCard}
                      onClick={() => setDetail(task)}
                      title={`${task.content?.title ?? ''} · ${TASK_STATUS_LABELS[task.status]}`}
                    >
                      <span className={styles.taskTitle}>{task.content?.title ?? task.contentId.slice(0, 6)}</span>
                      <span className={styles.taskMeta}>
                        {PLATFORM_LABELS[task.platform as PlatformCode]} · {TASK_STATUS_LABELS[task.status]}
                      </span>
                    </button>
                  ))
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Dialog
        open={Boolean(detail)}
        title="排期任务"
        onClose={() => setDetail(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDetail(null)}>
              关闭
            </Button>
            <Button
              icon={<RefreshIcon width={16} height={16} />}
              loading={retry.isPending}
              onClick={() => detail && retry.mutate(detail.id)}
            >
              重试/立即执行
            </Button>
          </>
        }
      >
        {detail ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mf-space-3)' }}>
            <strong>{detail.content?.title ?? detail.contentId}</strong>
            <div style={{ display: 'flex', gap: 'var(--mf-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
              <Tag tone="info">{PLATFORM_LABELS[detail.platform as PlatformCode]}</Tag>
              <Tag tone={TASK_STATUS_TONES[detail.status]}>{TASK_STATUS_LABELS[detail.status]}</Tag>
              <span style={{ fontSize: 'var(--mf-font-size-xs)', color: 'var(--mf-color-text-tertiary)' }}>
                排期 {detail.scheduledAt ? formatDateTime(detail.scheduledAt) : '立即'}
              </span>
              <span style={{ fontSize: 'var(--mf-font-size-xs)', color: 'var(--mf-color-text-tertiary)' }}>
                尝试 {detail.attempts}/{detail.maxAttempts}
              </span>
            </div>
            {detail.errorMessage ? (
              <Banner tone="danger">
                <span>{detail.errorMessage}</span>
              </Banner>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
