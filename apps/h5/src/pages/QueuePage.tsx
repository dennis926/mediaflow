import { useQuery } from '@tanstack/react-query';
import { PublishTaskStatus } from '@mediaflow/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { publishApi } from '../lib/api/endpoints';
import { TASK_STATUS_LABELS, TASK_STATUS_TONES, relativeTime } from '../lib/format';

const TABS: Array<{ key: string; label: string; status?: PublishTaskStatus }> = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待发布', status: PublishTaskStatus.Pending },
  { key: 'scheduled', label: '已排期', status: PublishTaskStatus.Scheduled },
  { key: 'manual', label: '待人工', status: PublishTaskStatus.ManualRequired },
  { key: 'published', label: '已发布', status: PublishTaskStatus.Published },
  { key: 'failed', label: '失败', status: PublishTaskStatus.Failed },
];

export function QueuePage() {
  const [active, setActive] = useState('all');
  const tab = TABS.find((item) => item.key === active) ?? TABS[0];

  const tasks = useQuery({
    queryKey: ['h5', 'tasks', tab.key],
    queryFn: () => publishApi.tasks({ status: tab.status, pageSize: 20 }),
  });

  return (
    <>
      <PageHeader title="发布队列" subtitle="按状态筛选任务" />
      <div className="app-main">
        <div className="tabs" role="tablist">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              className="tab"
              aria-selected={active === item.key}
              onClick={() => setActive(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 'var(--mf-space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mf-space-3)' }}>
          {tasks.isLoading ? (
            <>
              <div className="skeleton" />
              <div className="skeleton" />
              <div className="skeleton" />
            </>
          ) : tasks.data && tasks.data.items.length > 0 ? (
            tasks.data.items.map((task) => (
              <Link key={task.id} to={`/publish/task/${task.id}`} className="card task-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--mf-space-3)' }}>
                  <span className="title">{task.content?.title ?? task.contentId.slice(0, 8)}</span>
                  <span className={`tag tag-${TASK_STATUS_TONES[task.status]}`}>{TASK_STATUS_LABELS[task.status]}</span>
                </div>
                <div className="meta">
                  <span>{task.platform}</span>
                  <span>·</span>
                  <span>
                    尝试 {task.attempts}/{task.maxAttempts}
                  </span>
                  <span>·</span>
                  <span>{relativeTime(task.createdAt)}</span>
                </div>
                {task.errorMessage ? <span className="muted">{task.errorMessage}</span> : null}
              </Link>
            ))
          ) : (
            <div className="card" style={{ textAlign: 'center' }}>
              <span className="muted">该状态下暂无任务</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
