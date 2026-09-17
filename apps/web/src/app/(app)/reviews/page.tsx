'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { Dialog } from '../../../components/ui/Dialog';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Textarea } from '../../../components/ui/Field';
import { Pagination } from '../../../components/ui/Pagination';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { ApiError } from '../../../lib/api/client';
import { contentApi, reviewsApi } from '../../../lib/api/endpoints';
import type { Content, ReviewItem } from '../../../lib/api/types';
import { formatDateTime } from '../../../lib/format';
import { ContentIcon } from '../../../lib/icons';
import styles from './page.module.css';

const TABS = [
  { key: 'pending', label: '待审核' },
  { key: 'approved', label: '已通过' },
  { key: 'changes_requested', label: '要求修改' },
  { key: 'rejected', label: '已驳回' },
  { key: '', label: '全部' },
];

const STATUS_LABELS: Record<string, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
  changes_requested: '要求修改',
};

const STATUS_TONES: Record<string, 'warning' | 'success' | 'danger' | 'info'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  changes_requested: 'info',
};

const DEFAULT_CHECKLIST = ['compliance', 'aiDisclosure', 'facts', 'typos', 'brandVoice'];

export default function ReviewsPage() {
  const queryClient = useQueryClient();
  const [active, setActive] = useState('pending');
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<ReviewItem | null>(null);
  const [content, setContent] = useState<Content | null>(null);
  const [comments, setComments] = useState('');
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);

  const reviews = useQuery({
    queryKey: ['reviews', active, page],
    queryFn: () => reviewsApi.list({ status: active || undefined, page, pageSize: 10 }),
  });
  const labels = useQuery({ queryKey: ['reviews', 'checklist'], queryFn: () => reviewsApi.checklist() });

  const openDetail = async (review: ReviewItem): Promise<void> => {
    setTarget(review);
    setComments('');
    setChecklist(Object.fromEntries(DEFAULT_CHECKLIST.map((key) => [key, true])));
    try {
      setContent(await contentApi.get(review.contentId));
    } catch {
      setContent(null);
    }
  };

  const decide = useMutation({
    mutationFn: (decision: 'approved' | 'rejected' | 'changes_requested') =>
      reviewsApi.decide(target!.id, { decision, comments: comments.trim() || undefined, checklist }),
    onSuccess: (_result, decision) => {
      setTarget(null);
      setFeedback({
        tone: decision === 'approved' ? 'success' : 'info',
        text: decision === 'approved' ? '已通过审核，内容可进入发布流程' : '已记录审核意见，提交人会收到通知',
      });
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['contents'] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '审核失败' }),
  });

  const columns: Array<Column<ReviewItem>> = [
    {
      key: 'content',
      title: '内容',
      render: (row) => (
        <div className={styles.titleCell}>
          <span className={styles.titleStrong}>{row.contentTitle ?? row.contentId.slice(0, 8)}</span>
          <span className={styles.meta}>
            <span>第 {row.round} 轮</span>
            <span>·</span>
            <span>提交：{row.submittedByName ?? '—'}</span>
            <span>·</span>
            <span>{formatDateTime(row.createdAt)}</span>
          </span>
          {row.comments ? <span className={styles.comments}>意见：{row.comments}</span> : null}
        </div>
      ),
    },
    {
      key: 'status',
      title: '状态',
      width: '120px',
      render: (row) => <Tag tone={STATUS_TONES[row.status] ?? 'default'}>{STATUS_LABELS[row.status] ?? row.status}</Tag>,
    },
    {
      key: 'reviewer',
      title: '审核人',
      width: '140px',
      render: (row) => <span className={styles.meta}>{row.reviewerName ?? '—'}</span>,
    },
    {
      key: 'decidedAt',
      title: '处理时间',
      width: '160px',
      render: (row) => <span className={styles.meta}>{formatDateTime(row.decidedAt)}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      width: '120px',
      align: 'right',
      render: (row) => (
        <div className={styles.actions}>
          {row.status === 'pending' ? (
            <Button variant="text" size="sm" onClick={() => void openDetail(row)}>
              去审核
            </Button>
          ) : (
            <Button variant="text" size="sm" onClick={() => void openDetail(row)}>
              查看
            </Button>
          )}
        </div>
      ),
    },
  ];

  const canDecide = target?.status === 'pending';

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

      <Card flush>
        <div className={styles.tabs}>
          {TABS.map((tab) => (
            <button
              key={tab.key || 'all'}
              type="button"
              className={`${styles.tab} ${active === tab.key ? styles.tabActive : ''}`}
              onClick={() => {
                setActive(tab.key);
                setPage(1);
              }}
            >
              {tab.label}
              {tab.key === 'pending' && reviews.data?.pendingCount ? `（${reviews.data.pendingCount}）` : ''}
            </button>
          ))}
        </div>

        <div style={{ padding: 'var(--mf-space-4) 0 0' }}>
          {reviews.isLoading ? (
            <div style={{ padding: 'var(--mf-space-5)' }}>
              <SkeletonRows rows={4} />
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={reviews.data?.items ?? []}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="没有待处理的审核"
                  description="在内容编辑器里点「提交审核」后，审核人会在这里看到。"
                  icon={<ContentIcon width={22} height={22} />}
                />
              }
            />
          )}
        </div>

        <Pagination page={page} pageSize={10} total={reviews.data?.meta.total ?? 0} onChange={setPage} />
      </Card>

      <Dialog
        open={Boolean(target)}
        title={canDecide ? '审核内容' : '审核记录'}
        onClose={() => setTarget(null)}
        footer={
          canDecide ? (
            <>
              <Button variant="secondary" loading={decide.isPending} onClick={() => decide.mutate('changes_requested')}>
                要求修改
              </Button>
              <Button variant="danger" loading={decide.isPending} disabled={!comments.trim()} onClick={() => decide.mutate('rejected')}>
                驳回
              </Button>
              <Button loading={decide.isPending} onClick={() => decide.mutate('approved')}>
                通过
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setTarget(null)}>
              关闭
            </Button>
          )
        }
      >
        {content ? (
          <div className={styles.preview}>
            <strong>{content.title}</strong>
            <div className={styles.previewBody}>
              {content.body.slice(0, 1200)}
              {content.body.length > 1200 ? '…' : ''}
            </div>
            <div className={styles.meta} style={{ marginTop: 'var(--mf-space-3)' }}>
              <Tag tone="info">{content.status}</Tag>
              {content.aiGenerated ? <Tag tone="brand">AI 生成 · {content.aiFlagChecked ? '标识已复核' : '标识待复核'}</Tag> : null}
              {content.tags.map((tag) => (
                <Tag key={tag}>#{tag}</Tag>
              ))}
            </div>
          </div>
        ) : (
          <SkeletonRows rows={3} />
        )}

        {canDecide ? (
          <>
            <div className={styles.checklist}>
              {DEFAULT_CHECKLIST.map((key) => (
                <label key={key} className={styles.checkItem}>
                  <input
                    type="checkbox"
                    checked={Boolean(checklist[key])}
                    onChange={() => setChecklist({ ...checklist, [key]: !checklist[key] })}
                  />
                  {labels.data?.labels[key] ?? key}
                </label>
              ))}
            </div>
            <Textarea
              label="审核意见"
              name="comments"
              placeholder="驳回或要求修改时必填，例如：缺少数据来源、存在绝对化表述"
              value={comments}
              onChange={(event) => setComments(event.target.value)}
            />
          </>
        ) : (
          <Banner tone={STATUS_TONES[target?.status ?? 'pending'] === 'success' ? 'success' : 'info'}>
            <span>
              {STATUS_LABELS[target?.status ?? '']} · {target?.reviewerName ?? '—'} · {formatDateTime(target?.decidedAt ?? null)}
              {target?.comments ? ` · 意见：${target.comments}` : ''}
            </span>
          </Banner>
        )}

        <Banner tone="warning">
          <span>
            不能审核自己提交的内容。审核通过后，内容状态变为「已通过」（若在系统设置中开启「发布前必须审核通过」，只有已通过的内容才能创建发布任务）。
          </span>
        </Banner>
      </Dialog>
    </>
  );
}
