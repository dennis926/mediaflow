'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { EmptyState } from '../../../components/ui/EmptyState';
import { QueryError } from '../../../components/ui/QueryError';
import { Input, Select } from '../../../components/ui/Field';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { auditApi } from '../../../lib/api/endpoints';
import type { AuditLogItem } from '../../../lib/api/types';
import { AUDIT_ACTION_GROUPS, auditActionLabel } from '../../../lib/audit';
import { formatDateTime } from '../../../lib/format';
import { ReviewIcon } from '../../../lib/icons';
import styles from './page.module.css';

/** 谁在什么时候改了什么：出事时能自助追溯（此前只能查数据库）。 */
export default function AuditPage() {
  const [group, setGroup] = useState('');
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [keyword, setKeyword] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const actions = useQuery({ queryKey: ['audit', 'actions'], queryFn: () => auditApi.actions(90) });

  const logs = useQuery({
    queryKey: ['audit', 'logs', { group, action, actor, keyword, from, to, page }],
    queryFn: () =>
      auditApi.list({
        action: action || undefined,
        actionPrefix: action ? undefined : group || undefined,
        actor: actor || undefined,
        keyword: keyword || undefined,
        from: from ? new Date(`${from}T00:00:00+08:00`).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59+08:00`).toISOString() : undefined,
        page,
        pageSize: 20,
      }),
  });

  const columns: Array<Column<AuditLogItem>> = [
    {
      key: 'time',
      title: '时间',
      width: '170px',
      render: (row) => <span className={styles.meta}>{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'actor',
      title: '操作人',
      width: '140px',
      render: (row) => <span className={styles.actor}>{row.actorName ?? '（系统）'}</span>,
    },
    {
      key: 'action',
      title: '操作',
      width: '190px',
      render: (row) => (
        <div className={styles.tags}>
          <Tag tone="info">{auditActionLabel(row.action)}</Tag>
          <span className={styles.meta}>{row.action}</span>
        </div>
      ),
    },
    {
      key: 'resource',
      title: '对象',
      width: '150px',
      render: (row) => (
        <span className={styles.meta}>
          {row.resourceType}
          {row.resourceId ? ` · ${row.resourceId.slice(0, 8)}` : ''}
        </span>
      ),
    },
    {
      key: 'payload',
      title: '详情',
      render: (row) => (
        <div className={styles.payload}>
          <button type="button" className={styles.expand} onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
            {expanded === row.id ? '收起' : '查看'}
          </button>
          {expanded === row.id ? <pre className={styles.payloadText}>{JSON.stringify(row.payload, null, 2)}</pre> : null}
        </div>
      ),
    },
    { key: 'ip', title: '来源 IP', width: '130px', render: (row) => <span className={styles.meta}>{row.ip ?? '-'}</span> },
  ];

  return (
    <>
      <Banner tone="info">
        <span>
          审计日志记录所有关键写操作（谁、什么时候、改了什么），密钥类内容只记录「改了哪一项」、不记录值。
          可按动作类型、操作人、时间范围与关键字检索；只保留近 90 天的动作清单下拉，历史记录不会被删除。
        </span>
      </Banner>

      <Card>
        <div className={styles.toolbar}>
          <Select
            label="动作类型"
            name="group"
            options={AUDIT_ACTION_GROUPS.map((item) => ({ value: item.prefix, label: item.label }))}
            value={group}
            onChange={(event) => {
              setGroup(event.target.value);
              setAction('');
              setPage(1);
            }}
          />
          <Select
            label="具体动作"
            name="action"
            options={[{ value: '', label: '全部' }, ...(actions.data ?? []).map((item) => ({ value: item.action, label: `${auditActionLabel(item.action)}（${item.count}）` }))]}
            value={action}
            onChange={(event) => {
              setAction(event.target.value);
              setPage(1);
            }}
          />
          <Input label="操作人" name="actor" placeholder="姓名关键字" value={actor} onChange={(event) => setActor(event.target.value)} />
          <Input label="关键字" name="keyword" placeholder="动作/对象/详情内容" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
          <Input label="开始日期" name="from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          <Input label="结束日期" name="to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          <Button variant="secondary" onClick={() => setPage(1)}>
            查询
          </Button>
        </div>
      </Card>

      <Card flush>
        {logs.isError ? (
          <QueryError error={logs.error} action="加载审计日志" onRetry={() => void logs.refetch()} />
        ) : logs.isLoading ? (
          <div style={{ padding: 'var(--mf-space-5)' }}>
            <SkeletonRows rows={5} />
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={logs.data?.items ?? []}
            rowKey={(row) => row.id}
            empty={<EmptyState title="没有匹配的审计记录" description="换个时间范围或清空筛选条件再看看。" icon={<ReviewIcon width={22} height={22} />} />}
          />
        )}
        {logs.data && logs.data.meta.total > 0 ? (
          <div className={styles.pager}>
            <span className={styles.meta}>
              共 {logs.data.meta.total} 条，当前 {page}/{logs.data.meta.totalPages} 页
            </span>
            <span className={styles.actions}>
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((prev) => prev - 1)}>
                上一页
              </Button>
              <Button variant="secondary" size="sm" disabled={page >= logs.data.meta.totalPages} onClick={() => setPage((prev) => prev + 1)}>
                下一页
              </Button>
            </span>
          </div>
        ) : null}
      </Card>
    </>
  );
}
