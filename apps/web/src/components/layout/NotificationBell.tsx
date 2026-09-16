'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { notificationsApi } from '../../lib/api/endpoints';
import { formatDateTime } from '../../lib/format';
import { InboxIcon } from '../../lib/icons';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Tag } from '../ui/Tag';
import styles from './NotificationBell.module.css';

const LEVEL_TONES = { info: 'info', warning: 'warning', error: 'danger' } as const;

export function NotificationBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => notificationsApi.list({ pageSize: 10 }),
    refetchInterval: 30_000,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markAll = useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const unread = notifications.data?.unread ?? 0;

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.bell}
        aria-label={`通知${unread > 0 ? `（${unread} 条未读）` : ''}`}
        onClick={() => setOpen(!open)}
      >
        <InboxIcon />
        {unread > 0 ? <span className={styles.badge}>{unread > 99 ? '99+' : unread}</span> : null}
      </button>

      {open ? (
        <>
          <div className={styles.overlay} onClick={() => setOpen(false)} role="presentation" />
          <div className={styles.panel} role="dialog" aria-label="通知">
            <header className={styles.panelHeader}>
              <strong>通知</strong>
              <Button variant="text" size="sm" disabled={unread === 0 || markAll.isPending} onClick={() => markAll.mutate()}>
                全部已读
              </Button>
            </header>
            <div className={styles.list}>
              {notifications.isLoading ? (
                <span className={styles.muted}>加载中…</span>
              ) : notifications.data && notifications.data.items.length > 0 ? (
                notifications.data.items.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`${styles.item} ${item.status === 'unread' ? styles.unread : ''}`}
                    onClick={() => item.status === 'unread' && markRead.mutate(item.id)}
                  >
                    <span className={styles.itemTop}>
                      <Tag tone={LEVEL_TONES[item.level]}>{item.level === 'error' ? '失败' : item.level === 'warning' ? '待处理' : '通知'}</Tag>
                      <span className={styles.time}>{formatDateTime(item.createdAt)}</span>
                    </span>
                    <span className={styles.title}>{item.title}</span>
                    <span className={styles.body}>{item.body}</span>
                  </button>
                ))
              ) : (
                <EmptyState title="暂无通知" description="发布失败或需要人工处理时会出现在这里。" icon={<InboxIcon width={20} height={20} />} />
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
