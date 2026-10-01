'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Select } from '../../../components/ui/Field';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { ApiError } from '../../../lib/api/client';
import { aiApi } from '../../../lib/api/endpoints';
import type { AiGeneration, AiUsageModelRow, ModelPricingView, ProviderPricingView } from '../../../lib/api/types';
import { formatDateTime } from '../../../lib/format';
import { PlusIcon, SparkleIcon } from '../../../lib/icons';
import styles from './page.module.css';
import { ModelPriceDialog } from './ModelPriceDialog';
import { ProviderDialog } from './ProviderDialog';

const TASK_LABELS: Record<string, string> = {
  generate: '通用生成',
  adapt: '多平台适配',
  optimize_title: '标题优化',
  compliance_check: '合规检查',
  knowledge_generate: '知识库起草',
  knowledge_polish: '知识库润色',
};

interface ModelSelection {
  provider: string;
  model: string;
}

function yuan(value: string | number, digits = 4): string {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number === 0) return '0.0000';
  return number < 0.01 ? number.toFixed(6) : number.toFixed(digits);
}

function priceText(value: number): string {
  const number = Number(value ?? 0);
  // 四段单价是"官方价 × 汇率"算出来的浮点数，展示时统一收敛，避免 1.9600000000000002 这种尾数
  return `￥${(Math.round(number * 10000) / 10000).toFixed(number < 1 ? 4 : 2)}`;
}

function tokens(value: number): string {
  return (value ?? 0).toLocaleString('zh-CN');
}

/**
 * 官方价提示：分峰谷的供应商显示两档，否则显示美元官方价。
 * 分峰谷时用户最关心"现在按哪一档算"，所以当前档位加粗标注。
 */
function officialHint(row: ModelPricingView, field: 'input' | 'output' | 'cacheRead'): string {
  if (row.officialCny) {
    const peak = row.officialCny.peak[field];
    const off = row.officialCny.offpeak[field];
    if (peak === off) return `官方 ￥${peak}`;
    const current = row.tier === 'peak' ? peak : off;
    return `官方 峰 ￥${peak} / 谷 ￥${off}（当前 ￥${current}）`;
  }
  if (row.officialUsd) return `官方 $${row.officialUsd[field].toFixed(2)}`;
  return '官方价未收录';
}

/**
 * AI 用量与模型价格。
 *
 * 参考主流中转站价目表的做法：
 * 1. 顶部按**供应商**分组（只列你配置过的，未配置的灰显可先看价）；
 * 2. 供应商下按**模型**列价：输入 / 输出 / 缓存写入 / 缓存读取，每格显示实付价与官方价；
 * 3. 点某个模型即筛选出**该模型的用量**（调用、token、四段计费明细、按天趋势、最近调用）；
 * 4. 计价规则（官方价 × 汇率）直接写在页面上，价格可点击修改。
 */
export default function AiUsagePage() {
  const queryClient = useQueryClient();
  const [days, setDays] = useState(14);
  const [provider, setProvider] = useState<string | null>(null);
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [providerDialog, setProviderDialog] = useState<ProviderPricingView | null | 'new'>(null);
  const [priceDialog, setPriceDialog] = useState<AiUsageModelRow | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);

  const report = useQuery({
    queryKey: ['ai', 'usage-report', days, provider, selection],
    queryFn: () =>
      aiApi.usageReport(days, {
        provider: selection?.provider ?? provider ?? undefined,
        model: selection?.model,
      }),
  });
  const generations = useQuery({
    queryKey: ['ai', 'generations', 'recent', selection],
    queryFn: () => aiApi.generations({ page: 1, pageSize: 20 }),
  });

  /** 立即抓取官网价目表：成功后刷新价目（价格会立刻按新值计费）。 */
  const refreshOfficial = useMutation({
    mutationFn: () => aiApi.refreshOfficialPrices(),
    onSuccess: (result) => {
      const models = result.models.map((item) => item.model).join('、');
      setFeedback({
        tone: result.warning ? 'danger' : 'success',
        text: result.warning
          ? `抓取完成但有异常：${result.warning}`
          : `已从官网更新 ${result.models.length} 个模型的价格（${models}）`,
      });
      void queryClient.invalidateQueries({ queryKey: ['ai'] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '抓取官网价格失败' }),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['ai'] });
  };

  const removeProvider = useMutation({
    mutationFn: (value: string) => aiApi.removeProvider(value),
    onSuccess: () => {
      setFeedback({ tone: 'info', text: '供应商配置已删除' });
      refresh();
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '删除失败' }),
  });

  const data = report.data;
  const providers = data?.providers ?? [];
  const activeProvider = providers.find((item) => item.provider === provider);
  const summary = data?.summary;
  const breakdown = data?.costBreakdown;
  /** 模型价格（供应商视图）与用量（汇总视图）合并，保证每行都能看到次数与费用 */
  const usageByModelKey = new Map((data?.models ?? []).map((row) => [`${row.provider}/${row.model}`, row]));
  const mergedModels: AiUsageModelRow[] = (activeProvider?.models ?? data?.models ?? []).map((row) => {
    const used = usageByModelKey.get(`${row.provider}/${row.model}`);
    return {
      ...(row as AiUsageModelRow),
      calls: used?.calls ?? 0,
      tokens: used?.tokens ?? 0,
      cost: used?.cost ?? '0.000000',
    };
  });
  const selectedModel = selection
    ? providers.flatMap((item) => item.models).find((item) => item.provider === selection.provider && item.model === selection.model)
    : null;

  const modelColumns: Array<Column<AiUsageModelRow>> = [
    {
      key: 'model',
      title: '模型',
      render: (row) => (
        <div className={styles.modelCell}>
          <span className={styles.strong}>{row.model}</span>
          <span className={styles.meta}>
            {row.label !== row.model ? `${row.label} · ` : ''}
            {row.source === 'override'
              ? '已按官方调价'
              : row.source === 'official'
                ? '官网自动抓取价'
                : row.source === 'catalog'
                  ? '官方价（预置）'
                  : '全局兜底价'}
          </span>
        </div>
      ),
    },
    {
      key: 'input',
      title: '输入',
      width: '170px',
      render: (row) => (
        <span className={styles.priceCell}>
          <span className={styles.strong}>{priceText(row.price.input)} / 1M</span>
          <span className={styles.official}>{officialHint(row, 'input')}</span>
        </span>
      ),
    },
    {
      key: 'output',
      title: '输出',
      width: '170px',
      render: (row) => (
        <span className={styles.priceCell}>
          <span className={styles.strong}>{priceText(row.price.output)} / 1M</span>
          <span className={styles.official}>{officialHint(row, 'output')}</span>
        </span>
      ),
    },
    {
      key: 'cacheWrite',
      title: '缓存写入',
      width: '170px',
      render: (row) => (
        <span className={styles.priceCell}>
          <span className={styles.strong}>{priceText(row.price.cacheWrite)} / 1M</span>
          <span className={styles.official}>官方未单独报价，按输入价计</span>
        </span>
      ),
    },
    {
      key: 'cacheRead',
      title: '缓存读取',
      width: '170px',
      render: (row) => (
        <span className={styles.priceCell}>
          <span className={styles.strong}>{priceText(row.price.cacheRead)} / 1M</span>
          <span className={styles.official}>{officialHint(row, 'cacheRead')}</span>
        </span>
      ),
    },
    {
      key: 'usage',
      title: '本模型用量',
      width: '170px',
      render: (row) => (
        <div className={styles.modelCell}>
          <span className={styles.strong}>{row.calls} 次</span>
          <span className={styles.official}>
            {tokens(row.tokens)} token · ￥{yuan(row.cost)}
          </span>
        </div>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      width: '150px',
      align: 'right',
      render: (row) => (
        <span className={styles.actions}>
          <Button
            variant="text"
            size="sm"
            onClick={() => {
              setSelection({ provider: row.provider, model: row.model });
              setFeedback({ tone: 'info', text: `已筛选：${row.providerLabel} · ${row.model}` });
            }}
          >
            看用量
          </Button>
          <Button variant="text" size="sm" onClick={() => setPriceDialog(row)}>
            改价
          </Button>
        </span>
      ),
    },
  ];

  const billingColumns: Array<Column<{ item: string; unitPrice: number; tokens: number; amount: string }>> = [
    { key: 'item', title: '计费项', render: (row) => <span className={styles.strong}>{row.item}</span> },
    { key: 'unitPrice', title: '单价（元/百万 token）', width: '190px', render: (row) => <span className={styles.mono}>{priceText(row.unitPrice)}</span> },
    { key: 'tokens', title: '用量（token）', width: '170px', render: (row) => <span className={styles.mono}>{tokens(row.tokens)}</span> },
    { key: 'amount', title: '金额（元）', render: (row) => <span className={styles.mono}>{yuan(row.amount)}</span> },
  ];

  const byDayColumns: Array<Column<{ date: string; calls: number; tokens: number; cached: number; cost: string }>> = [
    { key: 'date', title: '日期', width: '120px', render: (row) => <span className={styles.mono}>{row.date}</span> },
    { key: 'calls', title: '调用次数', width: '100px', render: (row) => <span className={styles.mono}>{row.calls}</span> },
    { key: 'tokens', title: 'token 合计', width: '130px', render: (row) => <span className={styles.mono}>{tokens(row.tokens)}</span> },
    { key: 'cached', title: '其中缓存命中', width: '140px', render: (row) => <span className={styles.mono}>{tokens(row.cached)}</span> },
    { key: 'cost', title: '费用（元）', render: (row) => <span className={styles.mono}>{yuan(row.cost)}</span> },
  ];

  const generationColumns: Array<Column<AiGeneration>> = [
    { key: 'time', title: '时间', width: '170px', render: (row) => <span className={styles.meta}>{formatDateTime(row.createdAt)}</span> },
    { key: 'task', title: '任务', width: '140px', render: (row) => <Tag tone="info">{TASK_LABELS[row.taskType] ?? row.taskType}</Tag> },
    { key: 'provider', title: '供应商', width: '110px', render: (row) => <span className={styles.meta}>{row.provider}</span> },
    { key: 'model', title: '模型', width: '160px', render: (row) => <span className={styles.meta}>{row.model}</span> },
    { key: 'input', title: '输入', width: '100px', render: (row) => <span className={styles.mono}>{tokens(row.tokensInput)}</span> },
    { key: 'cache', title: '缓存读/写', width: '130px', render: (row) => <span className={styles.mono}>{tokens(row.tokensCached ?? 0)} / {tokens(row.tokensCacheWrite ?? 0)}</span> },
    { key: 'output', title: '输出', width: '100px', render: (row) => <span className={styles.mono}>{tokens(row.tokensOutput)}</span> },
    { key: 'latency', title: '耗时', width: '100px', render: (row) => <span className={styles.mono}>{row.latencyMs} ms</span> },
    { key: 'cost', title: '费用（元）', render: (row) => <span className={styles.mono}>{yuan(row.cost)}</span> },
  ];

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
          <Button
            variant="secondary"
            onClick={() => {
              setSelection(null);
              setProvider(null);
              setFeedback({ tone: 'info', text: '已切换为全部供应商汇总' });
            }}
          >
            查看全部汇总
          </Button>
          <Button variant="secondary" icon={<PlusIcon width={15} height={15} />} onClick={() => setProviderDialog('new')}>
            添加供应商
          </Button>
          {data ? (
            <span className={styles.meta}>
              <span className={data.rules.tier === 'peak' ? styles.tierPeak : styles.tierOffpeak}>
                {data.rules.tierLabel}
              </span>
              {data.rules.peakWindows ? `（高峰：${data.rules.peakWindows}）` : '（未配置峰谷时段）'}
              {data.rules.description ? ` · ${data.rules.description}` : ''}
            </span>
          ) : null}
          {data?.rules.scrapableProviders.length ? (
            <Button
              variant="secondary"
              loading={refreshOfficial.isPending}
              onClick={() => refreshOfficial.mutate()}
            >
              立即抓取官网价
            </Button>
          ) : null}
        </div>
      </Card>

      {report.isError ? (
        <Card>
          <EmptyState
            title="加载用量失败"
            description={report.error instanceof Error ? report.error.message : '请稍后重试'}
            icon={<SparkleIcon width={22} height={22} />}
            action={
              <Button variant="secondary" size="sm" onClick={() => void report.refetch()}>
                重试
              </Button>
            }
          />
        </Card>
      ) : report.isLoading ? (
        <Card>
          <SkeletonRows rows={4} />
        </Card>
      ) : (
        <>
          <Card>
            <div className={styles.tabs}>
              <button
                type="button"
                className={`${styles.tab} ${provider === null ? styles.tabActive : ''}`}
                onClick={() => {
                  setProvider(null);
                  setSelection(null);
                }}
              >
                全部供应商
              </button>
              {providers.map((item) => (
                <button
                  key={item.provider}
                  type="button"
                  className={`${styles.tab} ${provider === item.provider ? styles.tabActive : ''} ${item.configured ? '' : styles.tabMuted}`}
                  onClick={() => {
                    setProvider(item.provider);
                    setSelection(null);
                  }}
                >
                  {item.label}
                  {item.configured ? null : <span className={styles.tabBadge}>未配置</span>}
                </button>
              ))}
            </div>
            {activeProvider ? (
              <div className={styles.providerBar}>
                <span className={styles.meta}>
                  地址 {activeProvider.baseUrl || '（未填写）'} · 模型 {activeProvider.models.length} 个
                </span>
                {activeProvider.configured ? (
                  <>
                    <Button variant="text" size="sm" onClick={() => setProviderDialog(activeProvider)}>
                      编辑供应商
                    </Button>
                    <Button
                      variant="text"
                      size="sm"
                      loading={removeProvider.isPending}
                      onClick={() => {
                        if (window.confirm(`确定删除供应商「${activeProvider.label}」的配置吗？（用量历史会保留）`)) removeProvider.mutate(activeProvider.provider);
                      }}
                    >
                      删除配置
                    </Button>
                  </>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => setProviderDialog('new')}>
                    去配置密钥
                  </Button>
                )}
              </div>
            ) : null}
          </Card>

          <Card flush>
            <div className={styles.sectionHead}>
              <span className={styles.titleStrong}>{activeProvider ? `${activeProvider.label} 的模型价格与用量` : '全部模型的用量'}</span>
              <span className={styles.meta}>点「看用量」按模型筛选下方的统计；点「改价」可在官方调价时覆盖</span>
            </div>
            <DataTable
              columns={modelColumns}
              rows={selection ? mergedModels.filter((row) => row.provider === selection.provider && row.model === selection.model) : mergedModels}
              rowKey={(row) => `${row.provider}/${row.model}`}
              empty={<span className={styles.meta}>还没有模型：先点「添加供应商」配置密钥与模型</span>}
            />
            <div className={styles.priceNote}>
              <span className={styles.meta}>
                价格为各供应商<strong>官方价</strong>（不加价、不打折）：国内供应商直接取官网人民币价并区分<strong>峰谷两档</strong>，
                海外供应商按官方美元价 × 汇率 {data?.rules.usdToCny ?? 7} 折算；
                {data?.rules.scrapableProviders.length ? '系统会定时抓取官网价目表，官方调价后自动跟随，也可点上方「立即抓取官网价」。' : '官方调价后点「改价」即可覆盖该模型。'}
              </span>
            </div>
          </Card>

          <div className={styles.statGrid}>
            <Card>
              <span className={styles.statLabel}>调用次数</span>
              <span className={styles.statValue}>{summary?.calls ?? 0}</span>
              <span className={styles.meta}>{selection ? `${selection.provider} · ${selection.model}` : provider ? '当前供应商' : '全部供应商'} · 失败 {summary?.failed ?? 0} 次</span>
            </Card>
            <Card>
              <span className={styles.statLabel}>输入 token</span>
              <span className={styles.statValue}>{tokens(summary?.tokensInput ?? 0)}</span>
              <span className={styles.meta}>
                缓存命中 {tokens(summary?.tokensCached ?? 0)}（{summary?.cacheHitRate ?? 0}%）· 缓存写入 {tokens(summary?.tokensCacheWrite ?? 0)}
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
              <span className={styles.meta}>平均每次 {yuan(summary?.avgCostPerCall ?? 0)}</span>
            </Card>
          </div>

          <Card>
            <div className={styles.sectionHead}>
              <SparkleIcon width={16} height={16} />
              <span className={styles.sectionTitle}>计费明细（单价 × 用量 = 金额）</span>
              <span className={styles.meta}>
                {selectedModel
                  ? `当前模型：${selectedModel.model}（${selectedModel.source === 'override' ? '已按官方调价' : selectedModel.source === 'catalog' ? '官方价' : '全局兜底价'}）`
                  : data?.pricing
                    ? `当前模型：${data.pricing.model}`
                    : ''}
              </span>
            </div>
            <DataTable
              columns={billingColumns}
              rows={[
                { item: '输入 · 未命中缓存', unitPrice: selectedModel?.price.input ?? data?.pricing?.price.input ?? 0, tokens: Math.max(0, (summary?.tokensInput ?? 0) - (summary?.tokensCached ?? 0) - (summary?.tokensCacheWrite ?? 0)), amount: breakdown?.input ?? '0' },
                { item: '缓存写入', unitPrice: selectedModel?.price.cacheWrite ?? data?.pricing?.price.cacheWrite ?? 0, tokens: summary?.tokensCacheWrite ?? 0, amount: breakdown?.cacheWrite ?? '0' },
                { item: '缓存读取（命中）', unitPrice: selectedModel?.price.cacheRead ?? data?.pricing?.price.cacheRead ?? 0, tokens: summary?.tokensCached ?? 0, amount: breakdown?.cacheRead ?? '0' },
                { item: '输出', unitPrice: selectedModel?.price.output ?? data?.pricing?.price.output ?? 0, tokens: summary?.tokensOutput ?? 0, amount: breakdown?.output ?? '0' },
              ]}
              rowKey={(row) => row.item}
              empty={<span className={styles.meta}>暂无用量</span>}
            />
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>合计</span>
              <span className={styles.totalValue}>￥{yuan(breakdown?.total ?? 0)}</span>
              {data?.note ? <span className={styles.meta}>{data.note}（调用时记录 ￥{yuan(summary?.costRecorded ?? 0)}）</span> : null}
            </div>
          </Card>

          <Card>
            <span className={styles.sectionTitle}>按天统计</span>
            <DataTable columns={byDayColumns} rows={data?.byDay ?? []} rowKey={(row) => row.date} empty={<span className={styles.meta}>区间内没有调用记录</span>} />
          </Card>

          <Card flush>
            <div className={styles.sectionHead}>
              <span className={styles.titleStrong}>最近 20 次调用</span>
              <span className={styles.meta}>按供应商与模型显示，便于核对单价与用量</span>
            </div>
            <DataTable
              columns={generationColumns}
              rows={generations.data?.items ?? []}
              rowKey={(row) => row.id}
              empty={<EmptyState title="还没有调用记录" description="做一次多平台适配或让 AI 起草资料后，这里会显示每次调用的 token 与费用。" icon={<SparkleIcon width={22} height={22} />} />}
            />
          </Card>
        </>
      )}

      <ProviderDialog
        open={providerDialog !== null}
        current={providerDialog === 'new' ? null : providerDialog}
        onClose={() => setProviderDialog(null)}
        onSaved={(message) => {
          setFeedback({ tone: 'success', text: message });
          setProviderDialog(null);
          refresh();
        }}
        onError={(message) => setFeedback({ tone: 'danger', text: message })}
      />

      <ModelPriceDialog
        open={priceDialog !== null}
        row={priceDialog}
        onClose={() => setPriceDialog(null)}
        onSaved={(message) => {
          setFeedback({ tone: 'success', text: message });
          setPriceDialog(null);
          refresh();
        }}
        onError={(message) => setFeedback({ tone: 'danger', text: message })}
      />
    </>
  );
}
