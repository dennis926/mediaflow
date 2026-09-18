'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Card } from '../../../components/ui/Card';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Select } from '../../../components/ui/Field';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { aiApi } from '../../../lib/api/endpoints';
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

/** AI 用量与花费：调用次数、token 消耗、成本估算与最近调用明细。 */
export default function AiUsagePage() {
  const [days, setDays] = useState(14);
  const usage = useQuery({ queryKey: ['ai', 'usage', days], queryFn: () => aiApi.usage(days) });
  const generations = useQuery({ queryKey: ['ai', 'generations', 'recent'], queryFn: () => aiApi.generations({ page: 1, pageSize: 20 }) });

  const summary = usage.data?.summary;

  const dayColumns: Array<Column<{ date: string; calls: number; tokens: number; cost: string }>> = [
    { key: 'date', title: '日期', width: '130px', render: (row) => <span className={styles.mono}>{row.date}</span> },
    { key: 'calls', title: '调用次数', width: '110px', render: (row) => <span className={styles.mono}>{row.calls}</span> },
    { key: 'tokens', title: 'token 合计', width: '140px', render: (row) => <span className={styles.mono}>{row.tokens.toLocaleString('zh-CN')}</span> },
    { key: 'cost', title: '花费（元）', render: (row) => <span className={styles.mono}>{Number(row.cost).toFixed(4)}</span> },
  ];

  const taskColumns: Array<Column<{ taskType: string; calls: number; tokens: number; cost: string }>> = [
    { key: 'taskType', title: '任务类型', render: (row) => <Tag tone="info">{TASK_LABELS[row.taskType] ?? row.taskType}</Tag> },
    { key: 'calls', title: '调用次数', width: '110px', render: (row) => <span className={styles.mono}>{row.calls}</span> },
    { key: 'tokens', title: 'token 合计', width: '140px', render: (row) => <span className={styles.mono}>{row.tokens.toLocaleString('zh-CN')}</span> },
    { key: 'cost', title: '花费（元）', render: (row) => <span className={styles.mono}>{Number(row.cost).toFixed(4)}</span> },
  ];

  const generationColumns: Array<Column<AiGeneration>> = [
    { key: 'time', title: '时间', width: '170px', render: (row) => <span className={styles.meta}>{formatDateTime(row.createdAt)}</span> },
    { key: 'task', title: '任务', width: '150px', render: (row) => <Tag tone="info">{TASK_LABELS[row.taskType] ?? row.taskType}</Tag> },
    { key: 'model', title: '模型', width: '180px', render: (row) => <span className={styles.meta}>{row.model}</span> },
    {
      key: 'tokens',
      title: 'token（入/出）',
      width: '160px',
      render: (row) => (
        <span className={styles.mono}>
          {row.tokensInput} / {row.tokensOutput}
        </span>
      ),
    },
    { key: 'latency', title: '耗时', width: '110px', render: (row) => <span className={styles.mono}>{row.latencyMs} ms</span> },
    {
      key: 'status',
      title: '状态',
      width: '90px',
      render: (row) => <Tag tone={row.status === 'success' ? 'success' : 'danger'}>{row.status === 'success' ? '成功' : '失败'}</Tag>,
    },
    { key: 'cost', title: '花费（元）', render: (row) => <span className={styles.mono}>{Number(row.cost ?? 0).toFixed(4)}</span> },
  ];

  return (
    <>
      {summary && !summary.priceConfigured ? (
        <Banner tone="warning">
          <span>
            还没配置 token 单价，所以「花费」显示为 0。到「设置 → AI 服务」填入输入/输出单价（元/百万 token），这里就会按实际用量估算费用；
            只想统计次数与 token 的话可以不填。
          </span>
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
              区间内共 {summary.calls} 次调用（失败 {summary.failed} 次），平均耗时 {summary.avgLatencyMs} ms
            </span>
          ) : null}
        </div>
      </Card>

      {usage.isLoading ? (
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
              <span className={styles.statValue}>{(summary?.tokensInput ?? 0).toLocaleString('zh-CN')}</span>
              <span className={styles.meta}>提示词与引用资料</span>
            </Card>
            <Card>
              <span className={styles.statLabel}>输出 token</span>
              <span className={styles.statValue}>{(summary?.tokensOutput ?? 0).toLocaleString('zh-CN')}</span>
              <span className={styles.meta}>生成内容（含思考过程）</span>
            </Card>
            <Card>
              <span className={styles.statLabel}>估算花费</span>
              <span className={styles.statValue}>￥{Number(summary?.cost ?? 0).toFixed(4)}</span>
              <span className={styles.meta}>{summary?.priceConfigured ? '按配置单价估算' : '未配置单价'}</span>
            </Card>
          </div>

          <Card>
            <span className={styles.sectionTitle}>按天统计</span>
            <DataTable columns={dayColumns} rows={usage.data?.byDay ?? []} rowKey={(row) => row.date} empty={<span className={styles.meta}>区间内没有调用记录</span>} />
          </Card>

          <Card>
            <span className={styles.sectionTitle}>按任务类型 / 模型</span>
            <DataTable columns={taskColumns} rows={usage.data?.byTask ?? []} rowKey={(row) => row.taskType} empty={<span className={styles.meta}>暂无数据</span>} />
            <div className={styles.modelRow}>
              {(usage.data?.byModel ?? []).map((item) => (
                <Tag key={item.model} tone="default">
                  {item.model}：{item.calls} 次 / {item.tokens.toLocaleString('zh-CN')} token
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
                description="在内容编辑器里做多平台适配、或让 AI 起草知识库资料后，这里会显示每次调用的消耗。"
                icon={<SparkleIcon width={22} height={22} />}
              />
            }
          />
        )}
      </Card>
    </>
  );
}
