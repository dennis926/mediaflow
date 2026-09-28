'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_LABELS, PlatformCode } from '@mediaflow/shared';
import { tokens } from '@mediaflow/design-tokens';
import { useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { Dialog } from '../../../components/ui/Dialog';
import { Input, Select } from '../../../components/ui/Field';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { EmptyState } from '../../../components/ui/EmptyState';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { StatCard } from '../../../components/ui/StatCard';
import { Tag } from '../../../components/ui/Tag';
import { ApiError } from '../../../lib/api/client';
import { analyticsApi } from '../../../lib/api/endpoints';
import type { AccountRankingRow } from '../../../lib/api/types';
import { formatNumber } from '../../../lib/format';
import { AnalyticsIcon, InboxIcon, PublishIcon, RefreshIcon, WarningIcon } from '../../../lib/icons';
import styles from './page.module.css';

export default function AnalyticsPage() {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);
  /** 手动录入指标（无平台 API 时的取数路径） */
  const [manualOpen, setManualOpen] = useState(false);
  const [manualForm, setManualForm] = useState({
    platform: PlatformCode.WechatMp as PlatformCode,
    views: '',
    likes: '',
    comments: '',
    shares: '',
    favorites: '',
    note: '',
  });

  const manual = useMutation({
    mutationFn: () =>
      analyticsApi.manualMetrics({
        platform: manualForm.platform,
        views: Number(manualForm.views) || 0,
        likes: Number(manualForm.likes) || 0,
        comments: Number(manualForm.comments) || 0,
        shares: Number(manualForm.shares) || 0,
        favorites: Number(manualForm.favorites) || 0,
        note: manualForm.note.trim() || undefined,
      }),
    onSuccess: () => {
      setManualOpen(false);
      setManualForm({ platform: PlatformCode.WechatMp as PlatformCode, views: '', likes: '', comments: '', shares: '', favorites: '', note: '' });
      setFeedback({ tone: 'success', text: '指标已录入，数据看板与账号排行已更新' });
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '录入失败' }),
  });

  const overview = useQuery({ queryKey: ['analytics', 'overview'], queryFn: () => analyticsApi.overview() });
  const trend = useQuery({ queryKey: ['analytics', 'trend'], queryFn: () => analyticsApi.trend(14) });
  const ranking = useQuery({ queryKey: ['analytics', 'ranking'], queryFn: () => analyticsApi.ranking() });

  const sync = useMutation({
    mutationFn: () => analyticsApi.sync({ limit: 10 }),
    onSuccess: (result) =>
      setFeedback({
        tone: result.synced > 0 ? 'success' : 'info',
        text: `同步完成：成功 ${result.synced} 条，失败 ${result.failed} 条${
          result.results.find((item) => !item.ok) ? `（示例原因：${result.results.find((item) => !item.ok)?.message}）` : ''
        }`,
      }),
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '同步失败' }),
  });

  const columns: Array<Column<AccountRankingRow>> = [
    {
      key: 'account',
      title: '账号',
      render: (row) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--mf-space-2)' }}>
          <Tag tone="info">{PLATFORM_LABELS[row.platform as PlatformCode]}</Tag>
          <span>{row.accountName}</span>
        </div>
      ),
    },
    { key: 'published', title: '已发布', width: '100px', align: 'right', render: (row) => formatNumber(row.published) },
    { key: 'views', title: '阅读/播放', width: '120px', align: 'right', render: (row) => formatNumber(row.views) },
    { key: 'likes', title: '点赞', width: '100px', align: 'right', render: (row) => formatNumber(row.likes) },
    { key: 'comments', title: '评论', width: '100px', align: 'right', render: (row) => formatNumber(row.comments) },
    { key: 'shares', title: '分享', width: '100px', align: 'right', render: (row) => formatNumber(row.shares) },
  ];

  return (
    <>
      {feedback ? (
        <Banner tone={feedback.tone}>
          {feedback.text}
          <button
            type="button"
            onClick={() => setFeedback(null)}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}
          >
            知道了
          </button>
        </Banner>
      ) : null}

      <section className={styles.stats}>
        <StatCard label="内容总数" value={overview.data?.contents ?? '—'} hint={`其中 AI 生成 ${overview.data?.aiGenerated ?? 0}`} icon={<InboxIcon />} />
        <StatCard label="已发布" value={overview.data?.published ?? '—'} hint={`近 7 天 ${overview.data?.publishedLast7Days ?? 0} 条`} icon={<PublishIcon />} />
        <StatCard label="待处理" value={(overview.data?.pending ?? 0) + (overview.data?.manualRequired ?? 0)} hint="待发布 + 待人工发布" icon={<AnalyticsIcon />} />
        <StatCard label="发布失败" value={overview.data?.failed ?? '—'} hint="需要重试或检查账号" icon={<WarningIcon />} />
      </section>

      <section className={styles.grid}>
        <Card
          title="近 14 天趋势"
          extra={
            <>
              <Button size="sm" variant="secondary" onClick={() => setManualOpen(true)}>
                手动录入指标
              </Button>
              <Button size="sm" variant="secondary" icon={<RefreshIcon width={15} height={15} />} loading={sync.isPending} onClick={() => sync.mutate()}>
                同步平台数据
              </Button>
            </>
          }
        >
          {trend.isLoading ? (
            <SkeletonRows rows={5} />
          ) : (
            <>
              <div className={styles.chart}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend.data ?? []} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--mf-color-border-subtle)" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(value: string) => value.slice(5)} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        borderRadius: 'var(--mf-radius-md)',
                        border: '1px solid var(--mf-color-border-base)',
                        fontSize: 12,
                      }}
                      labelFormatter={(label: string) => `日期 ${label}`}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="published" name="已发布" stroke={tokens.color.success[500]} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="failed" name="失败" stroke={tokens.color.danger[500]} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="views" name="阅读/播放" stroke={tokens.color.brand[500]} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className={styles.legend}>
                <span className={styles.legendItem}>
                  <span className={styles.dot} style={{ background: tokens.color.brand[500] }} />
                  阅读/播放来自平台数据同步（未绑定账号时为 0）
                </span>
              </div>
            </>
          )}
        </Card>

        <Card title="账号排行">
          {ranking.isLoading ? (
            <SkeletonRows rows={4} />
          ) : ranking.data && ranking.data.length > 0 ? (
            <div className={styles.ranking}>
              {ranking.data.slice(0, 6).map((row, index) => (
                <div className={styles.rankRow} key={row.socialAccountId}>
                  <span className={styles.rankIndex}>{index + 1}</span>
                  <span className={styles.rankName}>
                    {row.accountName}
                    <span style={{ color: 'var(--mf-color-text-tertiary)', marginLeft: 'var(--mf-space-2)' }}>
                      {PLATFORM_LABELS[row.platform as PlatformCode]}
                    </span>
                  </span>
                  <span className={styles.rankValue}>{formatNumber(row.views)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="还没有绑定账号"
              description="绑定平台账号后，这里会按阅读/播放量排名。"
              icon={<AnalyticsIcon width={22} height={22} />}
            />
          )}
        </Card>
      </section>

      <Card title="账号数据明细">
        <DataTable
          columns={columns}
          rows={ranking.data ?? []}
          rowKey={(row) => row.socialAccountId}
          empty={
            <EmptyState
              title="暂无账号数据"
              description="绑定账号并成功发布后，点击「同步平台数据」即可看到明细。"
              icon={<AnalyticsIcon width={22} height={22} />}
            />
          }
        />
      </Card>
    
      <Dialog
        open={manualOpen}
        title="手动录入平台指标"
        onClose={() => setManualOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setManualOpen(false)}>
              取消
            </Button>
            <Button loading={manual.isPending} onClick={() => manual.mutate()}>
              保存指标
            </Button>
          </>
        }
      >
        <p style={{ margin: '0 0 var(--mf-space-4)', fontSize: 'var(--mf-font-size-sm)', color: 'var(--mf-color-text-secondary)' }}>
          没有平台 API 凭证时用这里：在平台后台看到数字后录进来（另一条路是浏览器插件自动回收）。
          录入会记审计，并立即计入数据看板与内容排行。
        </p>
        <div style={{ display: 'grid', gap: 'var(--mf-space-3)' }}>
          <Select
            label="平台"
            name="manualMetricsPlatform"
            options={Object.values(PlatformCode).map((platform) => ({ value: platform, label: PLATFORM_LABELS[platform] }))}
            value={manualForm.platform}
            onChange={(event) => setManualForm({ ...manualForm, platform: event.target.value as PlatformCode })}
          />
          <Input label="阅读/播放" name="manualViews" inputMode="numeric" value={manualForm.views} onChange={(event) => setManualForm({ ...manualForm, views: event.target.value })} />
          <Input label="点赞" name="manualLikes" inputMode="numeric" value={manualForm.likes} onChange={(event) => setManualForm({ ...manualForm, likes: event.target.value })} />
          <Input label="评论" name="manualComments" inputMode="numeric" value={manualForm.comments} onChange={(event) => setManualForm({ ...manualForm, comments: event.target.value })} />
          <Input label="分享" name="manualShares" inputMode="numeric" value={manualForm.shares} onChange={(event) => setManualForm({ ...manualForm, shares: event.target.value })} />
          <Input label="收藏" name="manualFavorites" inputMode="numeric" value={manualForm.favorites} onChange={(event) => setManualForm({ ...manualForm, favorites: event.target.value })} />
          <Input label="备注（可选）" name="manualNote" value={manualForm.note} onChange={(event) => setManualForm({ ...manualForm, note: event.target.value })} />
        </div>
      </Dialog>
</>
  );
}
