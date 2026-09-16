'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { Dialog } from '../../../components/ui/Dialog';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Input, Select } from '../../../components/ui/Field';
import { Pagination } from '../../../components/ui/Pagination';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { ApiError } from '../../../lib/api/client';
import { contentApi } from '../../../lib/api/endpoints';
import type { Content } from '../../../lib/api/types';
import {
  AI_FLAG_LABELS,
  CONTENT_STATUS_LABELS,
  CONTENT_STATUS_TONES,
  formatDateTime,
} from '../../../lib/format';
import { ContentIcon, EditIcon, PlusIcon, SearchIcon, TrashIcon } from '../../../lib/icons';
import { ContentStatus, PLATFORM_LABELS, PlatformCode } from '@mediaflow/shared';
import styles from './page.module.css';

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  ...Object.values(ContentStatus).map((status) => ({ value: status, label: CONTENT_STATUS_LABELS[status] })),
];

const PLATFORM_OPTIONS = [
  { value: '', label: '全部平台' },
  ...Object.values(PlatformCode).map((platform) => ({ value: platform, label: PLATFORM_LABELS[platform] })),
];

export default function ContentListPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const [page, setPage] = useState(1);
  const [pendingDelete, setPendingDelete] = useState<Content | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const query = useMemo(
    () => ({
      page,
      pageSize: 10,
      keyword: appliedKeyword || undefined,
      status: (status || undefined) as ContentStatus | undefined,
      platform: (platform || undefined) as PlatformCode | undefined,
    }),
    [page, appliedKeyword, status, platform],
  );

  const contents = useQuery({ queryKey: ['contents', query], queryFn: () => contentApi.list(query) });

  const remove = useMutation({
    mutationFn: (id: string) => contentApi.remove(id),
    onSuccess: () => {
      setFeedback('内容已删除（软删除，可在数据库中恢复）');
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['contents'] });
    },
    onError: (error: unknown) => {
      setFeedback(error instanceof ApiError ? error.message : '删除失败');
      setPendingDelete(null);
    },
  });

  const columns: Array<Column<Content>> = [
    {
      key: 'title',
      title: '内容',
      render: (row) => (
        <div className={styles.titleCell}>
          <Link className={styles.titleLink} href={`/content/edit?id=${row.id}`}>
            {row.title}
          </Link>
          <span className={styles.summary}>{row.summary ?? row.body.slice(0, 60)}</span>
        </div>
      ),
    },
    {
      key: 'status',
      title: '状态',
      width: '110px',
      render: (row) => <Tag tone={CONTENT_STATUS_TONES[row.status]}>{CONTENT_STATUS_LABELS[row.status]}</Tag>,
    },
    {
      key: 'ai',
      title: '来源标识',
      width: '150px',
      render: (row) => (
        <div className={styles.tags}>
          <Tag tone={row.aiGenerated ? 'brand' : 'default'}>{AI_FLAG_LABELS[row.aiFlagType]}</Tag>
          {row.aiGenerated ? (
            <Tag tone={row.aiFlagChecked ? 'success' : 'danger'}>{row.aiFlagChecked ? '已复核' : '待复核'}</Tag>
          ) : null}
        </div>
      ),
    },
    {
      key: 'tags',
      title: '标签',
      width: '180px',
      render: (row) => (
        <div className={styles.tags}>
          {row.tags.slice(0, 2).map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
          {row.tags.length > 2 ? <span className={styles.summary}>+{row.tags.length - 2}</span> : null}
        </div>
      ),
    },
    {
      key: 'updatedAt',
      title: '更新时间',
      width: '160px',
      render: (row) => <span className={styles.summary}>{formatDateTime(row.updatedAt)}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      width: '150px',
      align: 'right',
      render: (row) => (
        <div className={styles.actions}>
          <Button
            variant="text"
            size="sm"
            icon={<EditIcon width={15} height={15} />}
            onClick={() => router.push(`/content/edit?id=${row.id}`)}
          >
            编辑
          </Button>
          <Button
            variant="text"
            size="sm"
            icon={<TrashIcon width={15} height={15} />}
            onClick={() => setPendingDelete(row)}
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      {feedback ? (
        <Banner tone="info">
          {feedback}
          <button
            type="button"
            onClick={() => setFeedback(null)}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}
          >
            知道了
          </button>
        </Banner>
      ) : null}

      <Card flush>
        <div className={styles.toolbar} style={{ padding: 'var(--mf-space-5) var(--mf-space-5) 0' }}>
          <div className={styles.search}>
            <Input
              label="关键词"
              name="keyword"
              placeholder="搜索标题、摘要或正文"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setAppliedKeyword(keyword.trim());
                  setPage(1);
                }
              }}
            />
          </div>
          <div className={styles.filter}>
            <Select
              label="状态"
              name="status"
              options={STATUS_OPTIONS}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className={styles.filter}>
            <Select
              label="平台"
              name="platform"
              options={PLATFORM_OPTIONS}
              value={platform}
              onChange={(event) => {
                setPlatform(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <Button
            variant="secondary"
            icon={<SearchIcon width={16} height={16} />}
            onClick={() => {
              setAppliedKeyword(keyword.trim());
              setPage(1);
            }}
          >
            搜索
          </Button>
          <div className={styles.spacer}>
            <Link href="/content/edit">
              <Button icon={<PlusIcon width={16} height={16} />}>新建内容</Button>
            </Link>
          </div>
        </div>

        <div style={{ padding: 'var(--mf-space-4) 0 0' }}>
          {contents.isLoading ? (
            <div style={{ padding: 'var(--mf-space-5)' }}>
              <SkeletonRows rows={5} />
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={contents.data?.items ?? []}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="还没有内容"
                  description="创建第一篇内容，然后让 AI 生成公众号、小红书等平台版本。"
                  icon={<ContentIcon width={22} height={22} />}
                  action={
                    <Link href="/content/edit">
                      <Button size="sm" icon={<PlusIcon width={16} height={16} />}>
                        新建内容
                      </Button>
                    </Link>
                  }
                />
              }
            />
          )}
        </div>

        <Pagination
          page={page}
          pageSize={10}
          total={contents.data?.meta.total ?? 0}
          onChange={(next) => setPage(next)}
        />
      </Card>

      <Dialog
        open={Boolean(pendingDelete)}
        title="删除内容"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => pendingDelete && remove.mutate(pendingDelete.id)}
            >
              确认删除
            </Button>
          </>
        }
      >
        <span>
          即将删除「{pendingDelete?.title}」。删除为软删除：列表与接口立即不可见，数据行仍保留在数据库中。
        </span>
      </Dialog>
    </>
  );
}
