import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { RefreshIcon } from '../components/icons';
import { ApiError } from '../lib/api/client';
import { publishApi } from '../lib/api/endpoints';
import { TASK_STATUS_LABELS, TASK_STATUS_TONES, formatDateTime } from '../lib/format';

/** 复制到剪贴板：优先 Clipboard API，失败回退到临时 textarea（手机浏览器/非 https 也能用）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 走回退
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function TaskDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [reason, setReason] = useState('');
  const [hint, setHint] = useState('');

  const task = useQuery({ queryKey: ['h5', 'task', id], queryFn: () => publishApi.task(id), enabled: Boolean(id) });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['h5', 'task', id] });
    void queryClient.invalidateQueries({ queryKey: ['h5', 'tasks'] });
  };

  const retry = useMutation({ mutationFn: () => publishApi.retry(id), onSuccess: refresh });

  /**
   * 人工发布回填（手机上完成）：
   * 公众号等平台禁止 API 自动发布，成员在平台 App 里发完后直接在这里回填，不必回电脑。
   */
  const publish = useMutation({
    mutationFn: () => publishApi.markManualPublished(id, { url: url.trim() || undefined }),
    onSuccess: () => {
      setHint('已回填为「已发布」');
      refresh();
    },
    onError: (error: unknown) => setHint(error instanceof ApiError ? error.message : '回填失败'),
  });

  const fail = useMutation({
    mutationFn: () => publishApi.markManualFailed(id, { reason: reason.trim() }),
    onSuccess: () => {
      setHint('已标记为「发布失败」，可重试或重排');
      refresh();
    },
    onError: (error: unknown) => setHint(error instanceof ApiError ? error.message : '操作失败'),
  });

  const retryable = ['failed', 'manual_required', 'canceled', 'pending'].includes(task.data?.status ?? '');
  const manualStatuses = ['manual_required', 'pending', 'failed'];
  const content = task.data?.content as { title?: string; body?: string; tags?: string[] } | undefined;
  const variant = task.data?.contentVariant as { title?: string; body?: string } | null | undefined;
  const title = variant?.title ?? content?.title ?? '';
  const body = variant?.body ?? content?.body ?? '';
  const tagsText = (content?.tags ?? []).map((tag) => `#${tag}`).join(' ');

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

            {manualStatuses.includes(task.data.status) ? (
              <div className="card" style={{ marginTop: 'var(--mf-space-3)' }} data-testid="manual-publish-actions">
                <strong>人工发布回填</strong>
                <p className="muted">
                  公众号等平台禁止 API 自动发布；视频号/知乎/头条/百家号由插件填充后人工确认。
                  在手机上发完后可直接回填，不必回电脑。
                </p>
                <button
                  type="button"
                  className="btn btn-secondary btn-block"
                  onClick={async () => {
                    const ok = await copyText([title, '', body, tagsText].filter(Boolean).join('\n').trim());
                    setHint(ok ? '已复制正文与话题，可直接粘贴到平台 App' : '复制失败：请长按选中文本后复制');
                  }}
                >
                  复制正文与话题
                </button>
                <input
                  className="input"
                  style={{ marginTop: 'var(--mf-space-3)' }}
                  placeholder="发布后的链接（可选）"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  style={{ marginTop: 'var(--mf-space-2)' }}
                  disabled={publish.isPending}
                  onClick={() => publish.mutate()}
                >
                  {publish.isPending ? '提交中…' : '标记已发布'}
                </button>
                <input
                  className="input"
                  style={{ marginTop: 'var(--mf-space-3)' }}
                  placeholder="失败原因（标记失败时必填）"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-block"
                  style={{ marginTop: 'var(--mf-space-2)' }}
                  disabled={fail.isPending || reason.trim().length < 2}
                  onClick={() => fail.mutate()}
                >
                  {fail.isPending ? '提交中…' : '标记发布失败'}
                </button>
                {hint ? (
                  <div className="banner banner-info" style={{ marginTop: 'var(--mf-space-3)' }}>
                    {hint}
                  </div>
                ) : null}
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
          </>
        )}
      </div>
    </>
  );
}
