import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { PageHeader } from '../components/PageHeader';
import { RefreshIcon } from '../components/icons';
import { ApiError } from '../lib/api/client';
import { reviewsApi, type MobileReviewItem, type ReviewDecision } from '../lib/api/endpoints';
import { formatDateTime } from '../lib/format';
import { REVIEW_STATUS_LABELS, REVIEW_STATUS_TONES } from '../lib/roles';
import { usePullToRefresh } from '../hooks/usePullToRefresh';

const PENDING_KEY = ['h5', 'reviews', 'pending'] as const;

type NoticeTone = 'success' | 'danger';

interface Notice {
  tone: NoticeTone;
  text: string;
}

/** The list endpoint exposes both a joined `content` object and `contentTitle`. */
function reviewTitle(item: MobileReviewItem): string {
  const joined = item.content?.title?.trim();
  return item.contentTitle?.trim() || joined || `内容 ${item.contentId.slice(0, 8)}`;
}

function reviewSummary(item: MobileReviewItem): string {
  return item.content?.summary?.trim() ?? '';
}

function reviewSubmittedAt(item: MobileReviewItem): string | null {
  return item.submittedAt ?? item.createdAt ?? null;
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function ApprovalPage() {
  const queryClient = useQueryClient();

  const pending = useQuery({
    queryKey: PENDING_KEY,
    queryFn: () => reviewsApi.list({ status: 'pending', page: 1, pageSize: 20 }),
  });

  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<MobileReviewItem | null>(null);
  const [reason, setReason] = useState('');

  const refetchPending = useCallback(() => pending.refetch(), [pending]);
  const pull = usePullToRefresh(async () => {
    await refetchPending();
  });

  const decide = useMutation({
    mutationFn: (variables: { item: MobileReviewItem; decision: ReviewDecision; comments?: string }) =>
      reviewsApi.decide(variables.item.id, { decision: variables.decision, comments: variables.comments }),
    onMutate: (variables) => {
      setNotice(null);
      setBusyId(variables.item.id);
    },
    onSuccess: (_result, variables) => {
      setNotice({
        tone: 'success',
        text:
          variables.decision === 'approved'
            ? `已通过：${reviewTitle(variables.item)}`
            : `已驳回：${reviewTitle(variables.item)}`,
      });
      setRejectTarget(null);
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['h5', 'reviews'] });
    },
    onError: (error: unknown, variables) => {
      setNotice({ tone: 'danger', text: describeError(error, `处理「${reviewTitle(variables.item)}」失败，请稍后重试`) });
    },
    onSettled: () => setBusyId(null),
  });

  const items = pending.data?.items ?? [];
  const pendingCount = pending.data?.pendingCount ?? items.length;

  const listError =
    pending.isError && !pending.data ? describeError(pending.error, '审批列表加载失败，请稍后重试') : null;

  return (
    <>
      <PageHeader
        title="审批"
        subtitle={pending.data ? `待审核 ${pendingCount} 条` : '内容审核中心'}
        action={
          <button
            type="button"
            className="icon-button"
            aria-label="刷新"
            onClick={() => void refetchPending()}
            disabled={pending.isFetching}
          >
            <RefreshIcon />
          </button>
        }
      />
      <div className="app-main" ref={pull.ref}>
        <div className="pull-indicator" style={{ height: `${pull.distance}px` }} aria-hidden={pull.distance === 0}>
          {pull.refreshing ? '正在刷新…' : '下拉刷新'}
        </div>

        {notice ? (
          <div className={notice.tone === 'success' ? 'banner banner-info' : 'banner banner-danger'} role="status">
            {notice.text}
          </div>
        ) : null}

        {listError ? (
          <div className="banner banner-danger" role="alert">
            {listError}
          </div>
        ) : null}

        <div className="list-stack" style={{ marginTop: 'var(--mf-space-3)' }}>
          {pending.isLoading ? (
            <>
              <div className="skeleton" />
              <div className="skeleton" />
              <div className="skeleton" />
            </>
          ) : items.length === 0 && !listError ? (
            <div className="card empty-state">
              <strong>暂无待审批内容</strong>
              <span className="muted">内容在电脑端提交审核后，会出现在这里。</span>
            </div>
          ) : (
            items.map((item) => (
              <article key={item.id} className="card review-card">
                <div className="review-card-head">
                  <span className="title">{reviewTitle(item)}</span>
                  <span className={`tag tag-${REVIEW_STATUS_TONES[item.status] ?? 'warning'}`}>
                    {REVIEW_STATUS_LABELS[item.status] ?? item.status}
                  </span>
                </div>

                {reviewSummary(item) ? <span className="muted">{reviewSummary(item)}</span> : null}

                <div className="task-card-meta">
                  <span>提交人：{item.submittedByName ?? '未知'}</span>
                  <span>·</span>
                  <span>{formatDateTime(reviewSubmittedAt(item))}</span>
                  {item.round ? (
                    <>
                      <span>·</span>
                      <span>第 {item.round} 轮</span>
                    </>
                  ) : null}
                </div>

                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busyId === item.id}
                    onClick={() => {
                      setNotice(null);
                      setReason('');
                      setRejectTarget(item);
                    }}
                  >
                    驳回
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busyId === item.id}
                    onClick={() => decide.mutate({ item, decision: 'approved' })}
                  >
                    {busyId === item.id ? '处理中…' : '通过'}
                  </button>
                </div>
              </article>
            ))
          )}
        </div>

        {items.length > 0 ? (
          <span className="muted" style={{ display: 'block', textAlign: 'center', marginTop: 'var(--mf-space-4)' }}>
            共 {pending.data?.meta.total ?? items.length} 条待审核
          </span>
        ) : null}
      </div>

      <Dialog
        open={rejectTarget !== null}
        title="驳回原因"
        description={rejectTarget ? `《${reviewTitle(rejectTarget)}》将被退回给提交人。` : undefined}
        confirmLabel="确认驳回"
        danger
        busy={decide.isPending}
        confirmDisabled={reason.trim().length === 0}
        onCancel={() => {
          setRejectTarget(null);
          setReason('');
        }}
        onConfirm={() => {
          if (!rejectTarget) return;
          decide.mutate({ item: rejectTarget, decision: 'rejected', comments: reason.trim() });
        }}
      >
        <div className="field" style={{ marginTop: 'var(--mf-space-3)' }}>
          <label htmlFor="reject-reason">驳回理由（必填）</label>
          <textarea
            id="reject-reason"
            rows={3}
            maxLength={500}
            placeholder="请说明需要修改的地方，提交人据此调整后再提交"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <span className="muted">已填 {reason.trim().length}/500 字</span>
        </div>
      </Dialog>
    </>
  );
}
