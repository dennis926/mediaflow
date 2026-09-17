'use client';

import { useQuery } from '@tanstack/react-query';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { EmptyState } from '../../../components/ui/EmptyState';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { knowledgeApi } from '../../../lib/api/endpoints';
import type { KnowledgeAuditIssue } from '../../../lib/api/types';
import { formatDateTime } from '../../../lib/format';
import { CheckIcon, WarningIcon } from '../../../lib/icons';
import styles from './page.module.css';

const ISSUE_LABELS: Record<KnowledgeAuditIssue['kind'], { label: string; tone: 'warning' | 'danger' | 'info' | 'default' }> = {
  too_short: { label: '内容太短', tone: 'warning' },
  too_long: { label: '内容过长', tone: 'warning' },
  no_tags: { label: '缺标签/关键词', tone: 'info' },
  never_used: { label: '长期未被引用', tone: 'default' },
};

/** 知识库体检：重复条目 + 明显欠打磨的条目，点标题可直接去改。 */
export function AuditPanel({ onOpenItem }: { onOpenItem: (title: string) => void }) {
  const audit = useQuery({ queryKey: ['knowledge', 'audit'], queryFn: () => knowledgeApi.audit() });
  const report = audit.data;

  if (audit.isLoading) {
    return (
      <Card>
        <SkeletonRows rows={4} />
      </Card>
    );
  }

  if (!report) return <Banner tone="danger">体检失败，请稍后重试</Banner>;

  const healthy = report.duplicateGroups.length === 0 && report.issues.length === 0;

  return (
    <>
      <div className={styles.statGrid}>
        <Card>
          <span className={styles.statLabel}>资料总数</span>
          <span className={styles.statValue}>{report.summary.total}</span>
          <span className={styles.meta}>
            启用 {report.summary.active} · 停用 {report.summary.inactive}
          </span>
        </Card>
        <Card>
          <span className={styles.statLabel}>疑似重复</span>
          <span className={styles.statValue}>{report.summary.duplicateGroups}</span>
          <span className={styles.meta}>相似度 ≥ 75% 的条目对</span>
        </Card>
        <Card>
          <span className={styles.statLabel}>从未被引用</span>
          <span className={styles.statValue}>{report.summary.neverUsed}</span>
          <span className={styles.meta}>入库 30 天后仍未命中会单独提示</span>
        </Card>
        <Card>
          <span className={styles.statLabel}>AI 起草</span>
          <span className={styles.statValue}>{report.summary.aiGenerated}</span>
          <span className={styles.meta}>由 AI 生成、人工确认后入库</span>
        </Card>
      </div>

      {healthy ? (
        <Card>
          <EmptyState
            title="没有发现明显问题"
            description="没有重复条目，也没有过短、缺标签或长期闲置的资料。"
            icon={<CheckIcon width={22} height={22} />}
          />
        </Card>
      ) : null}

      {report.duplicateGroups.length > 0 ? (
        <Card>
          <div className={styles.sectionHead}>
            <WarningIcon width={18} height={18} />
            <span className={styles.titleStrong}>疑似重复的条目</span>
            <span className={styles.meta}>内容高度相似，建议合并成一条，避免 AI 引到两份口径</span>
          </div>
          <div className={styles.form}>
            {report.duplicateGroups.map((group) => (
              <div key={group.items.map((item) => item.id).join('-')} className={styles.chunkCard}>
                <div className={styles.chunkHead}>
                  <Tag tone="warning">相似度 {(group.similarity * 100).toFixed(0)}%</Tag>
                </div>
                {group.items.map((item) => (
                  <Button key={item.id} variant="text" size="sm" onClick={() => onOpenItem(item.title)}>
                    {item.title}（{item.brand}）
                  </Button>
                ))}
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {report.issues.length > 0 ? (
        <Card>
          <div className={styles.sectionHead}>
            <span className={styles.titleStrong}>需要打磨的条目（{report.issues.length}）</span>
          </div>
          <div className={styles.form}>
            {report.issues.map((issue) => (
              <div key={`${issue.id}-${issue.kind}`} className={styles.chunkCard}>
                <div className={styles.chunkHead}>
                  <Tag tone={ISSUE_LABELS[issue.kind].tone}>{ISSUE_LABELS[issue.kind].label}</Tag>
                  <Button variant="text" size="sm" onClick={() => onOpenItem(issue.title)}>
                    {issue.title}
                  </Button>
                  <span className={styles.meta}>{issue.brand}</span>
                </div>
                <span className={styles.meta}>{issue.detail}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <span className={styles.meta}>体检时间：{formatDateTime(report.summary.checkedAt)}（每次打开本页实时计算）</span>
    </>
  );
}
