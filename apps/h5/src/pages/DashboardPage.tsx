import { useQuery } from '@tanstack/react-query';
import { PublishTaskStatus } from '@mediaflow/shared';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { contentApi, publishApi } from '../lib/api/endpoints';

export function DashboardPage() {
  const contents = useQuery({ queryKey: ['h5', 'contents', 'count'], queryFn: () => contentApi.count({ pageSize: 1 }) });
  const pending = useQuery({
    queryKey: ['h5', 'tasks', 'pending'],
    queryFn: () => publishApi.tasks({ status: PublishTaskStatus.Pending, pageSize: 1 }),
  });
  const published = useQuery({
    queryKey: ['h5', 'tasks', 'published'],
    queryFn: () => publishApi.tasks({ status: PublishTaskStatus.Published, pageSize: 1 }),
  });
  const manual = useQuery({
    queryKey: ['h5', 'tasks', 'manual'],
    queryFn: () => publishApi.tasks({ status: PublishTaskStatus.ManualRequired, pageSize: 1 }),
  });
  const queue = useQuery({ queryKey: ['h5', 'queue'], queryFn: () => publishApi.queueStats() });

  return (
    <>
      <PageHeader title="工作台" subtitle="内容与发布概况" />
      <div className="app-main">
        <div className="stat-grid">
          <div className="stat-tile">
            <span className="label">内容总数</span>
            <span className="value">{contents.data?.meta.total ?? '…'}</span>
            <span className="hint">全部状态</span>
          </div>
          <div className="stat-tile">
            <span className="label">待发布</span>
            <span className="value">{pending.data?.meta.total ?? '…'}</span>
            <span className="hint">已入队</span>
          </div>
          <div className="stat-tile">
            <span className="label">已发布</span>
            <span className="value">{published.data?.meta.total ?? '…'}</span>
            <span className="hint">平台已确认</span>
          </div>
          <div className="stat-tile">
            <span className="label">待人工处理</span>
            <span className="value">{manual.data?.meta.total ?? '…'}</span>
            <span className="hint">含公众号等平台</span>
          </div>
        </div>

        <div className="card" style={{ marginTop: 'var(--mf-space-4)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>发布队列</strong>
            <Link to="/publish/queue" className="muted">
              查看全部
            </Link>
          </div>
          <div style={{ display: 'flex', gap: 'var(--mf-space-6)', marginTop: 'var(--mf-space-3)' }}>
            <div>
              <div style={{ fontSize: 'var(--mf-font-size-2xl)', fontWeight: 600 }}>{queue.data?.length ?? '…'}</div>
              <span className="muted">队列消息</span>
            </div>
            <div>
              <div style={{ fontSize: 'var(--mf-font-size-2xl)', fontWeight: 600 }}>{queue.data?.pending ?? '…'}</div>
              <span className="muted">未确认</span>
            </div>
            <div>
              <div style={{ fontSize: 'var(--mf-font-size-2xl)', fontWeight: 600 }}>{queue.data?.consumers ?? '…'}</div>
              <span className="muted">消费者</span>
            </div>
          </div>
        </div>

        <div className="card">
          <strong>快速入口</strong>
          <div style={{ display: 'flex', gap: 'var(--mf-space-3)', marginTop: 'var(--mf-space-3)' }}>
            <Link to="/publish/queue" className="btn btn-secondary" style={{ flex: 1 }}>
              发布队列
            </Link>
            <Link to="/approval" className="btn btn-secondary" style={{ flex: 1 }}>
              待审批
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
