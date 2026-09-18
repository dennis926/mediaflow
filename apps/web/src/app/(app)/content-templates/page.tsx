'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PLATFORM_LABELS, PlatformCode } from '@mediaflow/shared';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { Dialog } from '../../../components/ui/Dialog';
import { EmptyState } from '../../../components/ui/EmptyState';
import { QueryError } from '../../../components/ui/QueryError';
import { Input, Select, Textarea } from '../../../components/ui/Field';
import { Pagination } from '../../../components/ui/Pagination';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { ApiError } from '../../../lib/api/client';
import { templatesApi } from '../../../lib/api/endpoints';
import type { ContentTemplateItem } from '../../../lib/api/types';
import { formatDateTime } from '../../../lib/format';
import { EditIcon, PlusIcon, SparkleIcon } from '../../../lib/icons';
import { useSiteConfig } from '../../../lib/knowledge';
import styles from './page.module.css';

interface FormState {
  name: string;
  description: string;
  category: string;
  platform: string;
  title: string;
  body: string;
  tagsText: string;
  isActive: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  category: '',
  platform: '',
  title: '',
  body: '',
  tagsText: '',
  isActive: true,
};

/** 文案模板库：把常用写法沉淀下来，内容创作时一键套用。模板属于内容，可随时增删改。 */
export default function ContentTemplatesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const site = useSiteConfig();
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [platform, setPlatform] = useState('');
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ContentTemplateItem | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [pendingDelete, setPendingDelete] = useState<ContentTemplateItem | null>(null);
  const [preview, setPreview] = useState<ContentTemplateItem | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);

  const list = useQuery({
    queryKey: ['templates', { appliedKeyword, category, platform, page }],
    queryFn: () =>
      templatesApi.list({
        keyword: appliedKeyword || undefined,
        category: category || undefined,
        platform: platform || undefined,
        page,
        pageSize: site.pageSize,
      }),
  });
  const categories = useQuery({ queryKey: ['templates', 'categories'], queryFn: () => templatesApi.categories() });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        category: form.category.trim() || null,
        platform: form.platform || null,
        title: form.title,
        body: form.body,
        tags: form.tagsText
          .split(/[、,，\s]+/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        isActive: form.isActive,
      };
      return editing ? templatesApi.update(editing.id, payload) : templatesApi.create(payload);
    },
    onSuccess: () => {
      setFeedback({ tone: 'success', text: editing ? '模板已保存' : '模板已创建' });
      setFormOpen(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      void queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '保存失败' }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => templatesApi.remove(id),
    onSuccess: () => {
      setPendingDelete(null);
      setFeedback({ tone: 'info', text: '模板已删除（软删除，可在数据库中恢复）' });
      void queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '删除失败' }),
  });

  const toggle = useMutation({
    mutationFn: (item: ContentTemplateItem) => templatesApi.update(item.id, { isActive: !item.isActive }),
    onSuccess: (_result, item) => {
      setFeedback({ tone: 'info', text: item.isActive ? '模板已停用' : '模板已启用' });
      void queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '操作失败' }),
  });

  const columns: Array<Column<ContentTemplateItem>> = [
    {
      key: 'name',
      title: '模板',
      render: (row) => (
        <div className={styles.titleCell}>
          <span className={styles.titleStrong}>{row.name}</span>
          <span className={styles.preview}>{row.title}</span>
          <span className={styles.meta}>
            {row.category ? <Tag tone="info">{row.category}</Tag> : null}
            {row.platform ? <Tag tone="default">{PLATFORM_LABELS[row.platform as PlatformCode] ?? row.platform}</Tag> : <Tag tone="default">通用</Tag>}
            {!row.isActive ? <Tag tone="warning">已停用</Tag> : null}
          </span>
        </div>
      ),
    },
    { key: 'usage', title: '被套用', width: '100px', render: (row) => <span className={styles.meta}>{row.usageCount} 次</span> },
    {
      key: 'updated',
      title: '更新时间',
      width: '170px',
      render: (row) => <span className={styles.meta}>{formatDateTime(row.updatedAt)}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      width: '300px',
      align: 'right',
      render: (row) => (
        <div className={styles.actions}>
          <Button
            variant="text"
            size="sm"
            icon={<SparkleIcon width={14} height={14} />}
            onClick={() => router.push(`/content/new?template=${row.id}`)}
          >
            用它写内容
          </Button>
          <Button variant="text" size="sm" onClick={() => setPreview(row)}>
            预览
          </Button>
          <Button
            variant="text"
            size="sm"
            onClick={() => {
              setEditing(row);
              setForm({
                name: row.name,
                description: row.description ?? '',
                category: row.category ?? '',
                platform: row.platform ?? '',
                title: row.title,
                body: row.body,
                tagsText: row.tags.join('、'),
                isActive: row.isActive,
              });
              setFormOpen(true);
            }}
          >
            编辑
          </Button>
          <Button variant="text" size="sm" onClick={() => toggle.mutate(row)}>
            {row.isActive ? '停用' : '启用'}
          </Button>
          <Button variant="text" size="sm" onClick={() => setPendingDelete(row)}>
            删除
          </Button>
        </div>
      ),
    },
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

      <Banner tone="info">
        <span>
          把公司常用写法沉淀成模板（科普文、产品答疑、活动通知、朋友圈文案…），点「用它写内容」会带着标题、正文与标签直接打开编辑器，
          再交给 AI 做多平台适配。模板只是起点，套用后仍可自由修改；被套用次数会累计，方便看出哪些模板真正有用。
        </span>
      </Banner>

      <Card flush>
        <div className={styles.toolbar} style={{ padding: 'var(--mf-space-5) var(--mf-space-5) 0' }}>
          <div className={styles.search}>
            <Input
              label="搜索"
              name="templateKeyword"
              placeholder="模板名、标题或正文"
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
              label="分类"
              name="templateCategory"
              options={[{ value: '', label: '全部分类' }, ...(categories.data ?? []).map((item) => ({ value: item.category, label: `${item.category}（${item.count}）` }))]}
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className={styles.filter}>
            <Select
              label="平台"
              name="templatePlatform"
              options={[{ value: '', label: '全部平台' }, ...Object.entries(PLATFORM_LABELS).map(([value, label]) => ({ value, label }))]}
              value={platform}
              onChange={(event) => {
                setPlatform(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              setAppliedKeyword(keyword.trim());
              setPage(1);
            }}
          >
            搜索
          </Button>
          <div className={styles.spacer}>
            <Button
              icon={<PlusIcon width={16} height={16} />}
              onClick={() => {
                setEditing(null);
                setForm(EMPTY_FORM);
                setFormOpen(true);
              }}
            >
              新建模板
            </Button>
          </div>
        </div>

        <div style={{ padding: 'var(--mf-space-4) 0 0' }}>
          {list.isError ? (
          <QueryError error={list.error} action="加载模板" onRetry={() => void list.refetch()} />
        ) : list.isLoading ? (
            <div style={{ padding: 'var(--mf-space-5)' }}>
              <SkeletonRows rows={4} />
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={list.data?.items ?? []}
              rowKey={(row) => row.id}
              empty={<EmptyState title="还没有文案模板" description="把你最常用的写法存成模板，团队写作就能保持同一口径。" icon={<EditIcon width={22} height={22} />} />}
            />
          )}
        </div>

        <Pagination page={page} pageSize={site.pageSize} total={list.data?.meta.total ?? 0} onChange={setPage} />
      </Card>

      <Dialog
        open={formOpen}
        title={editing ? '编辑模板' : '新建模板'}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setFormOpen(false);
                setEditing(null);
              }}
            >
              取消
            </Button>
            <Button loading={save.isPending} disabled={!form.name.trim() || !form.title.trim() || !form.body.trim()} onClick={() => save.mutate()}>
              保存
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <div className={styles.twoCol}>
            <Input label="模板名称" name="name" required placeholder="例如：肠道健康科普文" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            <Input label="分类" name="category" placeholder="例如：科普 / 产品 / 活动 / 朋友圈" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} />
          </div>
          <div className={styles.twoCol}>
            <Select
              label="适用平台"
              name="platform"
              options={[{ value: '', label: '通用（不限平台）' }, ...Object.entries(PLATFORM_LABELS).map(([value, label]) => ({ value, label }))]}
              value={form.platform}
              onChange={(event) => setForm({ ...form, platform: event.target.value })}
            />
            <Input label="一句话说明" name="description" placeholder="这个模板适合什么场景" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </div>
          <Input label="标题（套用后写入内容标题）" name="title" required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          <Textarea label="正文骨架" name="body" required rows={10} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} />
          <Input label="标签（顿号/逗号分隔）" name="tags" value={form.tagsText} onChange={(event) => setForm({ ...form, tagsText: event.target.value })} />
        </div>
      </Dialog>

      <Dialog open={Boolean(preview)} title={preview?.name ?? '模板预览'} onClose={() => setPreview(null)}>
        {preview ? (
          <div className={styles.form}>
            <span className={styles.titleStrong}>{preview.title}</span>
            <pre className={styles.previewText}>{preview.body}</pre>
            <span className={styles.meta}>
              分类：{preview.category ?? '未分类'} · 平台：{preview.platform ? PLATFORM_LABELS[preview.platform as PlatformCode] ?? preview.platform : '通用'} ·
              被套用 {preview.usageCount} 次
              {preview.tags.length > 0 ? ` · 标签：${preview.tags.join('、')}` : ''}
            </span>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(pendingDelete)}
        title="删除模板"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => pendingDelete && remove.mutate(pendingDelete.id)}>
              确认删除
            </Button>
          </>
        }
      >
        <span>删除为软删除。确定删除模板「{pendingDelete?.name}」吗？</span>
      </Dialog>
    </>
  );
}
