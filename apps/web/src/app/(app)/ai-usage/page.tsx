'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { EmptyState } from '../../../components/ui/EmptyState';
import { QueryError } from '../../../components/ui/QueryError';
import { Select } from '../../../components/ui/Field';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { ApiError } from '../../../lib/api/client';
import { aiApi, settingsApi } from '../../../lib/api/endpoints';
import type { AiGeneration } from '../../../lib/api/types';
import { formatDateTime } from '../../../lib/format';
import { SparkleIcon } from '../../../lib/icons';
import styles from './page.module.css';

const TASK_LABELS: Record<string, string> = {
  generate: '通用生成',
  adapt: '多平台适配',
  optimize_title: '标题优化',
  compliance_check: '合规检查',
  knowledge_generate: '知识库起草',
  knowledge_polish: '知识库润色',
};

/** DeepSeek 官网参考价（元/百万 token）：缓存命中输入更便宜。以官网实时价格为准，这里只做一键预填。 */
const DEEPSEEK_REFERENCE_PRICES = { input: '2', cached: '0.5', output: '8' };

function yuan(value: string | number, digits = 4): string {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return '0.0000';
  if (number === 0) return '0.0000';
  // 小额费用保留更多位，避免显示成 0.0000
  return number < 0.01 ? number.toFixed(6) : number.toFixed(digits);
}

function tokens(value: number): string {
  return (value ?? 0).toLocaleString('zh-CN');
}

/**
 * AI 用量与花费。
 *
 * 计价方式与主流大模型官网一致：**输入（缓存命中）/ 输入（缓存未命中）/ 输出** 三段分别计价，
 * 页面上给出"单价 × 用量 = 金额"的明细，合计即本期实际消费；未配置单价时只统计用量、费用显示 0。
 */
export default function AiUsagePage() {
  const queryClient = useQueryClient();
  const [days, setDays] = useState(14);
  const [feedback, setFeedback] = useState<string>('');

  const usage = useQuery({ queryKey: ['ai', 'usage', days], queryFn: () => aiApi.usage(days) });
  const generations = useQuery({ queryKey: ['ai', 'generations', 'recent'], queryFn: () => aiApi.generations({ page: 1, pageSize: 20 }) });

  const fillReferencePrices = useMutation({
    mutationFn: () =>
      settingsApi.update([
        { key: 'AI_PRICE_INPUT_PER_MTOK', value: DEEPSEEK_REFERENCE_PRICES.input },
        { key: 'AI_PRICE_CACHED_INPUT_PER_MTOK', value: DEEPSEEK_REFERENCE_PRICES.cached },
        { key: 'AI_PRICE_OUTPUT_PER_MTOK', value: DEEPSEEK_REFERENCE_PRICES.output },
      ]),
    onSuccess: () => {
      setFeedback('已填入 DeepSeek 参考单价，历史调用的费用会按新单价重新估算（以官网实时价格为准，可在「设置 → AI 服务」微调）');
      void queryClient.invalidateQueries({ queryKey: ['ai', 'usage'] });
    },
    onError: (error: unknown) => setFeedback(error instanceof ApiError ? error.message : '写入失败'),
  });

  const summary = usage.data?.summary;
  const pricing = usage.data?.pricing;
  const breakdown = usage.data?.costBreakdown;

  const billingColumns: Array<Column<{ item: string; unitPrice: number; tokens: number; amount: string; hint: string }>> = [
    { key: 'item', title: '计费项', render: (row) => <span className={styles.strong}>{row.item}</span> },
    { key: 'unitPrice', title: '单价（元/百万 token）', width: '190px', render: (row) => <span className={styles.mono}>{row.unitPrice}</span> },
    { key: 'tokens', title: '用量（token）', width: '170px', render: (row) => <span className={styles.mono}>{tokens(row.tokens)}</span> },
    { key: 'amount', title: '金额（元）', width: '150px', render: (row) => <span className={styles.mono}>{yuan(row.amount)}</span> },
    { key: 'hint', title: '说明', render: (row) => <span className={styles.meta}>{row.hint}</span> },
  ];

  const billingRows = breakdown
    ? [
        { item: '输入 · 未命中缓存', unitPrice: breakdown.inputMissed.unitPrice, tokens: breakdown.inputMissed.tokens, amount: breakdown.inputMissed.amount, hint: '提示词与引用资料首次送入' },
        { item: '输入 · 命中缓存', unitPrice: breakdown.inputCached.unitPrice, tokens: breakdown.inputCached.tokens, amount: breakdown.inputCached.amount, hint: '同一前缀重复使用，价格通常便宜很多' },
        { item: '输出', unitPrice: breakdown.output.unitPrice, tokens: breakdown.output.tokens, amount: breakdown.output.amount, hint: '生成内容，推理模型的思考 token 也算在这里' },
      ]
    : [];

  const dayColumns: Array<Column<{ date: string; calls: number; tokens: number; cached: number; cost: string }>> = [
    { key: 'date', title: '日期', width: '120px', render: (row) => <span className={styles.mono}>{row.date}</span> },
    { key: 'calls', title: '调用次数', width: '100px', render: (row) => <span className={styles.mono}>{row.calls}</span> },
    { key: 'tokens', title: 'token 合计', width: '130px', render: (row) => <span className={styles.mono}>{tokens(row.tokens)}</span> },
    { key: 'cached', title: '其中缓存命中', width: '140px', render: (row) => <span className={styles.mono}>{tokens(row.cached)}</span> },
    { key: 'cost', title: '费用（元）', render: (row) => <span className={styles.mono}>{yuan(row.cost)}</span> },
  ];

  const taskColumns: Array<Column<{ taskType: string; calls: number; tokens: number; cached: number; cost: string }>> = [
    { key: 'taskType', title: '任务类型', render: (row) => <Tag tone="info">{TASK_LABELS[row.taskType] ?? row.taskType}</Tag> },
    { key: 'calls', title: '调用次数', width: '100px', render: (row) => <span className={styles.mono}>{row.calls}</span> },
    { key: 'tokens', title: 'token 合计', width: '130px', render: (row) => <span className={styles.mono}>{tokens(row.tokens)}</span> },
    { key: 'cached', title: '其中缓存命中', width: '140px', render: (row) => <span className={styles.mono}>{tokens(row.cached)}</span> },
    { key: 'cost', title: '费用（元）', render: (row) => <span className={styles.mono}>{yuan(row.cost)}</span> },
  ];

  const generationColumns: Array<Column<AiGeneration>> = [
    { key: 'time', title: '时间', width: '170px', render: (row) => <span className={styles.meta}>{formatDateTime(row.createdAt)}</span> },
    { key: 'task', title: '任务', width: '140px', render: (row) => <Tag tone="info">{TASK_LABELS[row.taskType] ?? row.taskType}</Tag> },
    { key: 'model', title: '模型', width: '170px', render: (row) => <span className={styles.meta}>{row.model}</span> },
    { key: 'input', title: '输入', width: '100px', render: (row) => <span className={styles.mono}>{tokens(row.tokensInput)}</span> },
    { key: 'cached', title: '缓存命中', width: '110px', render: (row) => <span className={styles.mono}>{tokens(row.tokensCached ?? 0)}</span> },
    { key: 'output', title: '输出', width: '100px', render: (row) => <span className={styles.mono}>{tokens(row.tokensOutput)}</span> },
    { key: 'latency', title: '耗时', width: '100px', render: (row) => <span className={styles.mono}>{row.latencyMs} ms</span> },
    {
      key: 'status',
      title: '状态',
      width: '90px',
      render: (row) => <Tag tone={row.status === 'success' ? 'success' : 'danger'}>{row.status === 'success' ? '成功' : '失败'}</Tag>,
    },
    { key: 'cost', title: '费用（元）', render: (row) => <span className={styles.mono}>{yuan(row.cost)}</span> },
  ];

  return (
    <>
      {feedback ? (
        <Banner tone="info">
          {feedback}
          <button type="button" onClick={() => setFeedback('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>
            知道了
          </button>
        </Banner>
      ) : null}

      {summary && !summary.priceConfigured ? (
        <Banner tone="warning">
          <span>
            还没配置 token 单价，所以「费用」显示为 0（用量照常统计）。可以一键填入 DeepSeek 参考价，或到「设置 → AI 服务」按服务商官网价格填写
            —— 输入（缓存命中）/ 输入（未命中）/ 输出 三段分别计价，填完这里就会给出实际消费。
          </span>
          <Button size="sm" variant="secondary" loading={fillReferencePrices.isPending} onClick={() => fillReferencePrices.mutate()}>
            填入 DeepSeek 参考价
          </Button>
        </Banner>
      ) : null}

      <Card>
        <div className={styles.toolbar}>
          <Select
            label="统计范围"
            name="days"
            options={[
              { value: '7', label: '近 7 天' },
              { value: '14', label: '近 14 天' },
              { value: '30', label: '近 30 天' },
              { value: '90', label: '近 90 天' },
            ]}
            value={String(days)}
            onChange={(event) => setDays(Number(event.target.value))}
          />
          {summary ? (
            <span className={styles.meta}>
              区间内 {summary.calls} 次调用（失败 {summary.failed} 次） · 平均耗时 {summary.avgLatencyMs} ms · 平均每次 {yuan(summary.avgCostPerCall)}
            </span>
          ) : null}
        </div>
      </Card>

      {usage.isError ? (
        <Card>
          <QueryError error={usage.error} action="加载用量统计" onRetry={() => void usage.refetch()} />
        </Card>
      ) : usage.isLoading ? (
        <Card>
          <SkeletonRows rows={3} />
        </Card>
      ) : (
        <>
          <div className={styles.statGrid}>
            <Card>
              <span className={styles.statLabel}>调用次数</span>
              <span className={styles.statValue}>{summary?.calls ?? 0}</span>
              <span className={styles.meta}>失败 {summary?.failed ?? 0} 次</span>
            </Card>
            <Card>
              <span className={styles.statLabel}>输入 token</span>
              <span className={styles.statValue}>{tokens(summary?.tokensInput ?? 0)}</span>
              <span className={styles.meta}>
                缓存命中 {tokens(summary?.tokensCached ?? 0)}（命中率 {summary?.cacheHitRate ?? 0}%）
              </span>
            </Card>
            <Card>
              <span className={styles.statLabel}>输出 token</span>
              <span className={styles.statValue}>{tokens(summary?.tokensOutput ?? 0)}</span>
              <span className={styles.meta}>其中推理（思考）{tokens(summary?.tokensReasoning ?? 0)}</span>
            </Card>
            <Card>
              <span className={styles.statLabel}>合计费用</span>
              <span className={styles.statValue}>￥{yuan(summary?.cost ?? 0)}</span>
              <span className={styles.meta}>{summary?.priceConfigured ? '按配置单价计算' : '未配置单价'}</span>
            </Card>
          </div>

          <Card>
            <div className={styles.sectionHead}>
              <SparkleIcon width={16} height={16} />
              <span className={styles.sectionTitle}>计费明细（单价 × 用量 = 金额）</span>
              <span className={styles.meta}>
                当前单价：输入未命中 {pricing?.inputPerMTok ?? 0} · 输入命中 {pricing?.cachedInputPerMTok ?? 0} · 输出 {pricing?.outputPerMTok ?? 0}（元/百万 token）
              </span>
            </div>
            <DataTable columns={billingColumns} rows={billingRows} rowKey={(row) => row.item} empty={<span className={styles.meta}>暂无用量</span>} />
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>合计</span>
              <span className={styles.totalValue}>￥{yuan(breakdown?.total ?? 0)}</span>
              <span className={styles.meta}>
                = 输入未命中 {yuan(breakdown?.inputMissed.amount ?? 0)} + 输入命中 {yuan(breakdown?.inputCached.amount ?? 0)} + 输出 {yuan(breakdown?.output.amount ?? 0)}
              </span>
            </div>
            {summary && Math.abs(Number(summary.cost) - Number(summary.costRecorded)) > 0.000001 ? (
              <div className={styles.totalRow}>
                <span className={styles.meta}>
                  说明：以上金额按「当前单价 × 实际 token」重算；调用当时记录的金额合计为 ￥{yuan(summary.costRecorded)}，
                  差异来自单价调整（或早期未配置单价时的记录）。想按调用当时的价看，请以「最近调用」里的费用列为准。
                </span>
              </div>
            ) : null}
          </Card>

          <Card>
            <span className={styles.sectionTitle}>按天统计</span>
            <DataTable columns={dayColumns} rows={usage.data?.byDay ?? []} rowKey={(row) => row.date} empty={<span className={styles.meta}>区间内没有调用记录</span>} />
          </Card>

          <Card>
            <span className={styles.sectionTitle}>按任务类型</span>
            <DataTable columns={taskColumns} rows={usage.data?.byTask ?? []} rowKey={(row) => row.taskType} empty={<span className={styles.meta}>暂无数据</span>} />
            <div className={styles.modelRow}>
              {(usage.data?.byModel ?? []).map((item) => (
                <Tag key={item.model} tone="default">
                  {item.model}：{item.calls} 次 / {tokens(item.tokens)} token（缓存 {tokens(item.cached)}）/ ￥{yuan(item.cost)}
                </Tag>
              ))}
            </div>
          </Card>
        </>
      )}

      <Card flush>
        <div className={styles.sectionHead}>
          <SparkleIcon width={16} height={16} />
          <span className={styles.sectionTitle}>最近 20 次调用</span>
        </div>
        {generations.isLoading ? (
          <div style={{ padding: 'var(--mf-space-5)' }}>
            <SkeletonRows rows={4} />
          </div>
        ) : (
          <DataTable
            columns={generationColumns}
            rows={generations.data?.items ?? []}
            rowKey={(row) => row.id}
            empty={
              <EmptyState
                title="还没有调用记录"
                description="在内容编辑器里做多平台适配、或让 AI 起草知识库资料后，这里会显示每次调用的 token 与费用。"
                icon={<SparkleIcon width={22} height={22} />}
              />
            }
          />
        )}
      </Card>
    </>
  );
}
