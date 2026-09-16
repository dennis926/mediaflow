import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { RefreshIcon } from '../components/icons';
import { ApiError } from '../lib/api/client';
import { publishApi } from '../lib/api/endpoints';
import { TASK_STATUS_LABELS, TASK_STATUS_TONES, formatDateTime } from '../lib/format';

export function TaskDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();

  const task = useQuery({ queryKey: ['h5', 'task', id], queryFn: () => publishApi.task(id), enabled: Boolean(id) });

  const retry = useMutation({
    mutationFn: () => publishApi.retry(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['h5', 'task', id] });
      void queryClient.invalidateQueries({ queryKey: ['h5', 'tasks'] });
    },
  });

  const retryable = ['failed', 'manual_required', 'canceled', 'pending'].includes(task.data?.status ?? '');

  return (
    <>
      <PageHeader title="任务详情" subtitle={task.data?.platform} back />
      <div className="app-main">
        {task.isLoading ? (
          <div className="skeleton" />
        ) : task.isError || !task.data ? (
          <div className="banner banner-danger">任务不存在或已被删除</div>
        ) : (
          <>
            <div className="card task-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--mf-space-3)' }}>
                <span className="title">{task.data.content?.title ?? '未命名内容'}</span>
                <span className={`tag tag-${TASK_STATUS_TONES[task.data.status]}`}>
                  {TASK_STATUS_LABELS[task.data.status]}
                </span>
              </div>
              <div className="meta">
                <span>平台：{task.data.platform}</span>
                <span>·</span>
                <span>发布方式：{task.data.publishMode}</span>
              </div>
              <div className="meta">
                <span>
                  尝试 {task.data.attempts}/{task.data.maxAttempts}
                </span>
                <span>·</span>
                <span>创建 {formatDateTime(task.data.createdAt)}</span>
              </div>
              {task.data.finishedAt ? <div className="meta">完成 {formatDateTime(task.data.finishedAt)}</div> : null}
            </div>

            {task.data.errorMessage ? (
              <div className="card">
                <strong>失败原因</strong>
                <p className="muted" style={{ marginBottom: 0 }}>
                  {task.data.errorMessage}
                </p>
              </div>
            ) : null}

            {typeof task.data.extra?.manualMessage === 'string' ? (
              <div className="card">
                <strong>需要人工操作</strong>
                <p className="muted" style={{ marginBottom: 0 }}>
                  {String(task.data.extra.manualMessage)}
                </p>
              </div>
            ) : null}

            {task.data.platformUrl ? (
              <div className="card">
                <strong>平台链接</strong>
                <a href={task.data.platformUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--mf-color-text-link)' }}>
                  {task.data.platformUrl}
                </a>
              </div>
            ) : null}

            {retry.isError ? (
              <div className="banner banner-danger" style={{ marginTop: 'var(--mf-space-3)' }}>
                {retry.error instanceof ApiError ? retry.error.message : '重试失败'}
              </div>
            ) : null}
            {retry.isSuccess ? (
              <div className="banner banner-info" style={{ marginTop: 'var(--mf-space-3)' }}>
                已重新入队，稍后刷新查看结果
              </div>
            ) : null}

            <div style={{ marginTop: 'var(--mf-space-4)' }}>
              <button
                type="button"
                className="btn btn-primary btn-block"
                disabled={!retryable || retry.isPending}
                onClick={() => retry.mutate()}
              >
                <RefreshIcon width={18} height={18} />
                {retry.isPending ? '提交中…' : retryable ? '重试发布' : '当前状态不可重试'}
              </button>
            </div>

            <div className="card" style={{ marginTop: 'var(--mf-space-3)' }}>
              <span className="muted">
                公众号等平台禁止 API 自动发布，任务会停留在「待人工发布」，需要到电脑端复制内容手动发布。
              </span>
            </div>
          </>
        )}
      </div>
    </>
  );
}
