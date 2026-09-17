'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { Dialog } from '../../../components/ui/Dialog';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Input, Select, Textarea } from '../../../components/ui/Field';
import { Pagination } from '../../../components/ui/Pagination';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { ApiError } from '../../../lib/api/client';
import { authApi, knowledgeApi } from '../../../lib/api/endpoints';
import type { KnowledgeItem } from '../../../lib/api/types';
import { formatDateTime } from '../../../lib/format';
import { KnowledgeIcon, PlusIcon } from '../../../lib/icons';
import { sourceFileName, useKnowledgeCategories } from '../../../lib/knowledge';
import { SparkleIcon } from '../../../lib/icons';
import { AuditPanel } from './AuditPanel';
import { CategoriesPanel } from './CategoriesPanel';
import { ImportReviewDialog } from './ImportReviewDialog';
import { MatchPanel } from './MatchPanel';
import { SourcesPanel } from './SourcesPanel';
import { TransferPanel } from './TransferPanel';
import styles from './page.module.css';

type KnowledgeCategory = KnowledgeItem['category'];

interface FormState {
  brand: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  tagsText: string;
  keywordsText: string;
  priority: number;
  isActive: boolean;
}

const EMPTY_FORM: FormState = {
  brand: '',
  category: 'product',
  title: '',
  content: '',
  tagsText: '',
  keywordsText: '',
  priority: 5,
  isActive: true,
};

export default function KnowledgePage() {
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [brand, setBrand] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<KnowledgeItem | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeItem | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [tab, setTab] = useState<'list' | 'sources' | 'match' | 'audit' | 'categories' | 'transfer'>('list');
  const [aiPoints, setAiPoints] = useState('');
  const [aiNote, setAiNote] = useState('');
  const [aiDrafted, setAiDrafted] = useState(false);
  /** 最近一次导入的来源文件，用于一键定位这批资料。 */
  const [lastImported, setLastImported] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);

  const { categories, label: categoryLabel, tone: categoryTone } = useKnowledgeCategories();
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: () => authApi.me(), staleTime: 300_000 });
  const canEditCategories = (me.data?.roles ?? []).some((role) => ['owner', 'admin', 'editor'].includes(role));

  const list = useQuery({
    queryKey: ['knowledge', { appliedKeyword, brand, category, status, page }],
    queryFn: () =>
      knowledgeApi.list({
        keyword: appliedKeyword || undefined,
        brand: brand || undefined,
        category: category || undefined,
        isActive: status || undefined,
        page,
        pageSize: 10,
      }),
  });
  const brands = useQuery({ queryKey: ['knowledge', 'brands'], queryFn: () => knowledgeApi.brands() });

  useEffect(() => {
    if (!editing) return;
    setForm({
      brand: editing.brand,
      category: editing.category,
      title: editing.title,
      content: editing.content,
      tagsText: editing.tags.join('、'),
      keywordsText: editing.keywords.join('、'),
      priority: editing.priority,
      isActive: editing.isActive,
    });
  }, [editing]);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['knowledge'] });
  };
  const onError = (error: unknown, fallback: string): void =>
    setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : fallback });

  const payload: Partial<KnowledgeItem> = {
    brand: form.brand.trim(),
    aiGenerated: aiDrafted,
    category: form.category,
    title: form.title.trim(),
    content: form.content,
    tags: form.tagsText.split(/[、,，\s]+/).map((tag) => tag.trim()).filter(Boolean),
    keywords: form.keywordsText.split(/[、,，\s]+/).map((word) => word.trim()).filter(Boolean),
    priority: Number(form.priority) || 0,
  };

  /** AI 起草：把要点扩写成一条规范资料，填进表单由人工确认后才保存。 */
  const draft = useMutation({
    mutationFn: () =>
      knowledgeApi.aiDraft({
        brand: form.brand.trim(),
        category: form.category,
        points: aiPoints.trim(),
      }),
    onSuccess: (result) => {
      setForm((prev) => ({
        ...prev,
        title: result.draft.title,
        content: result.draft.content,
        tagsText: result.draft.tags.join('、'),
        keywordsText: result.draft.keywords.join('、'),
      }));
      setAiDrafted(true);
      setAiNote(`由 AI 起草（${result.model}），已参考：${result.references.join('、') || '无同名品牌资料'}。请核对事实后再保存。`);
    },
    onError: (error: unknown) => setAiNote(error instanceof ApiError ? `AI 起草失败：${error.message}` : 'AI 起草失败'),
  });

  /** AI 润色：只改表达与合规，不动事实；结果仍由人工确认后才保存。 */
  const polish = useMutation({
    mutationFn: () => knowledgeApi.aiPolish({ brand: form.brand.trim(), category: form.category, content: form.content }),
    onSuccess: (result) => {
      setForm((prev) => ({ ...prev, content: result.content }));
      setAiDrafted(true);
      setAiNote('已用 AI 润色（事实未变，请复核数字与规格）。');
    },
    onError: (error: unknown) => setAiNote(error instanceof ApiError ? `AI 润色失败：${error.message}` : 'AI 润色失败'),
  });

  const create = useMutation({
    mutationFn: () => knowledgeApi.create(payload),
    onSuccess: () => {
      setFormOpen(false);
      setForm(EMPTY_FORM);
      setFeedback({ tone: 'success', text: '资料已新增，AI 生成时会自动引用' });
      refresh();
    },
    onError: (error: unknown) => onError(error, '新增失败'),
  });

  const update = useMutation({
    mutationFn: () => knowledgeApi.update(editing!.id, { ...payload, isActive: form.isActive }),
    onSuccess: () => {
      setEditing(null);
      setFormOpen(false);
      setFeedback({ tone: 'success', text: '资料已保存' });
      refresh();
    },
    onError: (error: unknown) => onError(error, '保存失败'),
  });

  const toggle = useMutation({
    mutationFn: (item: KnowledgeItem) => knowledgeApi.update(item.id, { isActive: !item.isActive }),
    onSuccess: (_result, item) => {
      setFeedback({ tone: 'info', text: item.isActive ? '已停用（不再被 AI 引用）' : '已启用' });
      refresh();
    },
    onError: (error: unknown) => onError(error, '操作失败'),
  });

  const remove = useMutation({
    mutationFn: (item: KnowledgeItem) => knowledgeApi.remove(item.id),
    onSuccess: () => {
      setPendingDelete(null);
      setFeedback({ tone: 'info', text: '资料已删除（软删除，保留审计记录）' });
      refresh();
    },
    onError: (error: unknown) => onError(error, '删除失败'),
  });

  const columns: Array<Column<KnowledgeItem>> = [
    {
      key: 'title',
      title: '资料',
      render: (row) => (
        <div className={styles.titleCell}>
          <span className={styles.titleStrong}>
            {row.title}
            {row.aiGenerated ? <Tag tone="warning">AI 起草</Tag> : null}
          </span>
          <span className={styles.preview}>{row.content.replace(/\n/g, ' ')}</span>
          <span className={styles.meta}>
            {row.tags.slice(0, 4).map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
            {row.keywords.slice(0, 3).map((word) => (
              <Tag key={word} tone="info">
                {word}
              </Tag>
            ))}
          </span>
        </div>
      ),
    },
    {
      key: 'brand',
      title: '品牌 / 分类',
      width: '170px',
      render: (row) => (
        <div className={styles.tags}>
          <Tag tone="default">{row.brand}</Tag>
          <Tag tone={categoryTone(row.category)}>{categoryLabel(row.category)}</Tag>
        </div>
      ),
    },
    {
      key: 'priority',
      title: '优先级',
      width: '90px',
      align: 'center',
      render: (row) => <span className={styles.usage}>{row.priority}</span>,
    },
    {
      key: 'usage',
      title: '被引用',
      width: '130px',
      render: (row) => (
        <div className={styles.meta}>
          <span className={styles.usage}>{row.usageCount} 次</span>
          <span>{row.lastUsedAt ? formatDateTime(row.lastUsedAt) : '未使用'}</span>
        </div>
      ),
    },
    {
      key: 'source',
      title: '来源',
      width: '150px',
      render: (row) => {
        const origin = sourceFileName(row.sourceUrl);
        if (!origin) return <span className={styles.meta}>手动录入</span>;
        return (
          <div className={styles.meta}>
            <span title={origin}>{origin}</span>
            {row.tags.includes('含图片识别内容') ? <Tag tone="warning">含图片识别</Tag> : null}
          </div>
        );
      },
    },
    {
      key: 'status',
      title: '状态',
      width: '90px',
      render: (row) => <Tag tone={row.isActive ? 'success' : 'default'}>{row.isActive ? '启用' : '停用'}</Tag>,
    },
    {
      key: 'actions',
      title: '操作',
      width: '190px',
      align: 'right',
      render: (row) => (
        <div className={styles.actions}>
          <Button variant="text" size="sm" onClick={() => { setEditing(row); setAiPoints(''); setAiNote(''); setAiDrafted(false); setFormOpen(true); }}>
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
          {lastImported.length > 0 ? (
            <span className={styles.bannerAction}>
              {lastImported.map((name) => (
                <Button
                  key={name}
                  variant="text"
                  size="sm"
                  onClick={() => {
                    setKeyword(name);
                    setAppliedKeyword(name);
                    setPage(1);
                  }}
                >
                  查看「{name}」导入的资料
                </Button>
              ))}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setFeedback(null);
              setLastImported([]);
            }} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>
            知道了
          </button>
        </Banner>
      ) : null}

      {tab === 'list' ? (
      <Banner tone="info">
        <span>流程：导入文档后<strong>先校对、再入库</strong>——解析结果（含图片 OCR 文字）会先给你逐片核对修改，点「确认无误」才写入；入库后在列表里仍可随时编辑、停用或删除。</span>
        <span>
          规则：AI 做多平台适配时，会按内容的标题/正文/标签与这里的「标签 + 关键词」匹配，取优先级最高的若干条（默认 5 条）拼进提示词；被引用的资料会累加「被引用次数」，方便识别哪些资料真正有用。停用的资料不参与匹配。
        </span>
      </Banner>
      ) : null}

      <div className={styles.tabs}>
        {([
          { key: 'list', label: '资料' },
          { key: 'sources', label: '来源管理' },
          { key: 'match', label: '检索测试' },
          { key: 'audit', label: '质量体检' },
          { key: 'categories', label: '分类设置' },
          { key: 'transfer', label: '导入导出' },
        ] as const).map((item) => (
          <button
            key={item.key}
            type="button"
            className={`${styles.tab} ${tab === item.key ? styles.tabActive : ''}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'sources' ? <SourcesPanel onOpenItem={(name) => { setTab('list'); setKeyword(name); setAppliedKeyword(name); setPage(1); }} /> : null}
      {tab === 'match' ? <MatchPanel /> : null}
      {tab === 'audit' ? <AuditPanel onOpenItem={(title) => { setTab('list'); setKeyword(title); setAppliedKeyword(title); setPage(1); }} /> : null}
      {tab === 'categories' ? <CategoriesPanel canEdit={canEditCategories} /> : null}
      {tab === 'transfer' ? <TransferPanel /> : null}

      {tab === 'list' ? (
      <Card flush>
        <div className={styles.toolbar} style={{ padding: 'var(--mf-space-5) var(--mf-space-5) 0' }}>
          <div className={styles.search}>
            <Input
              label="搜索"
              name="keyword"
              placeholder="标题、正文或品牌"
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
              label="品牌"
              name="brand"
              options={[{ value: '', label: '全部品牌' }, ...(brands.data ?? []).map((item) => ({ value: item.brand, label: `${item.brand}（${item.count}）` }))]}
              value={brand}
              onChange={(event) => { setBrand(event.target.value); setPage(1); }}
            />
          </div>
          <div className={styles.filter}>
            <Select
              label="分类"
              name="category"
              options={[{ value: '', label: '全部分类' }, ...categories.map((item) => ({ value: item.code, label: `${item.label}${item.count ? `（${item.count}）` : ''}` }))]}
              value={category}
              onChange={(event) => { setCategory(event.target.value); setPage(1); }}
            />
          </div>
          <div className={styles.filter}>
            <Select
              label="状态"
              name="status"
              options={[{ value: '', label: '全部' }, { value: 'true', label: '启用中' }, { value: 'false', label: '已停用' }]}
              value={status}
              onChange={(event) => { setStatus(event.target.value); setPage(1); }}
            />
          </div>
          <Button variant="secondary" onClick={() => { setAppliedKeyword(keyword.trim()); setPage(1); }}>
            搜索
          </Button>
          <div className={styles.spacer} style={{ display: 'flex', gap: 'var(--mf-space-2)' }}>
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              导入文档
            </Button>
            <Button variant="secondary" icon={<SparkleIcon width={16} height={16} />} onClick={() => { setEditing(null); setForm(EMPTY_FORM); setAiPoints(''); setAiNote(''); setAiDrafted(false); setFormOpen(true); }}>
              AI 起草资料
            </Button>
            <Button icon={<PlusIcon width={16} height={16} />} onClick={() => { setEditing(null); setForm(EMPTY_FORM); setAiPoints(''); setAiNote(''); setAiDrafted(false); setFormOpen(true); }}>
              新增资料
            </Button>
          </div>
        </div>

        <div style={{ padding: 'var(--mf-space-4) 0 0' }}>
          {list.isLoading ? (
            <div style={{ padding: 'var(--mf-space-5)' }}>
              <SkeletonRows rows={5} />
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={list.data?.items ?? []}
              rowKey={(row) => row.id}
              empty={<EmptyState title="还没有品牌资料" description="把品牌定位、产品卖点、成分说明和合规红线录进来，AI 生成就会照着写。" icon={<KnowledgeIcon width={22} height={22} />} />}
            />
          )}
        </div>

        <Pagination page={page} pageSize={10} total={list.data?.meta.total ?? 0} onChange={setPage} />
      </Card>
      ) : null}

      <Dialog
        open={formOpen}
        title={editing ? '编辑品牌资料' : '新增品牌资料'}
        onClose={() => { setFormOpen(false); setEditing(null); }}
        footer={
          <>
            <Button variant="secondary" onClick={() => { setFormOpen(false); setEditing(null); }}>
              取消
            </Button>
            <Button
              loading={create.isPending || update.isPending}
              disabled={!payload.brand || !payload.title || !form.content.trim()}
              onClick={() => (editing ? update.mutate() : create.mutate())}
            >
              保存
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          {!editing ? (
            <div className={styles.aiBox}>
              <div className={styles.chunkHead}>
                <SparkleIcon width={16} height={16} />
                <span className={styles.titleStrong}>AI 起草（可跳过，直接手写）</span>
                <span className={styles.meta}>写下要点，AI 按分类扩写成规范条目；生成后仍需你核对再保存</span>
              </div>
              <Textarea
                label="要点（一行一条）"
                name="aiPoints"
                rows={3}
                placeholder={'例如：\n畅享版含五种益生元复配\n突出稀缺水苏糖\n出厂活菌大于 200 亿 CFU/盒'}
                value={aiPoints}
                onChange={(event) => setAiPoints(event.target.value)}
              />
              <div className={styles.reviewToolbar}>
                <Button
                  variant="secondary"
                  icon={<SparkleIcon width={16} height={16} />}
                  loading={draft.isPending}
                  disabled={!form.brand.trim() || aiPoints.trim().length < 5}
                  onClick={() => draft.mutate()}
                >
                  AI 起草条目
                </Button>
                <Button
                  variant="text"
                  loading={polish.isPending}
                  disabled={form.content.trim().length < 20}
                  onClick={() => polish.mutate()}
                >
                  润色当前内容
                </Button>
              </div>
              {aiNote ? <span className={styles.meta}>{aiNote}</span> : null}
            </div>
          ) : (
            <div className={styles.reviewToolbar}>
              <Button variant="text" loading={polish.isPending} disabled={form.content.trim().length < 20} onClick={() => polish.mutate()}>
                <SparkleIcon width={15} height={15} /> 用 AI 润色这条资料
              </Button>
              {aiNote ? <span className={styles.meta}>{aiNote}</span> : null}
            </div>
          )}
          {aiDrafted ? <Banner tone="warning">这条资料由 AI 起草，保存后会标记「AI 起草」便于日后追溯；数字、规格、认证信息请务必人工核对。</Banner> : null}
          <div className={styles.twoCol}>
            <Input label="品牌" name="brand" required placeholder="例如：卿尔美" value={form.brand} onChange={(event) => setForm({ ...form, brand: event.target.value })} />
            <Select
              label="分类"
              name="category"
              options={categories.map((item) => ({ value: item.code, label: item.label }))}
              value={form.category}
              onChange={(event) => setForm({ ...form, category: event.target.value as KnowledgeCategory })}
            />
          </div>
          <Input label="标题" name="title" required placeholder="例如：畅享版卖点" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          <Textarea
            label="内容（AI 会照着这段写）"
            name="content"
            required
            hint="建议写成「规格 / 配方 / 卖点 / 可写与不可写的表述」"
            value={form.content}
            onChange={(event) => setForm({ ...form, content: event.target.value })}
          />
          <Input label="标签" name="tags" placeholder="用顿号分隔，例如：益生菌、肠道" value={form.tagsText} onChange={(event) => setForm({ ...form, tagsText: event.target.value })} />
          <Input label="关键词" name="keywords" placeholder="用于匹配内容正文，例如：水苏糖、CC-09" value={form.keywordsText} onChange={(event) => setForm({ ...form, keywordsText: event.target.value })} />
          <div className={styles.twoCol}>
            <Input
              label="优先级（0-100，越大越优先被引用）"
              name="priority"
              type="number"
              value={String(form.priority)}
              onChange={(event) => setForm({ ...form, priority: Number(event.target.value) })}
            />
            {editing ? (
              <Select
                label="状态"
                name="isActive"
                options={[{ value: 'true', label: '启用' }, { value: 'false', label: '停用（不参与匹配）' }]}
                value={form.isActive ? 'true' : 'false'}
                onChange={(event) => setForm({ ...form, isActive: event.target.value === 'true' })}
              />
            ) : null}
          </div>
        </div>
        <Banner tone="warning">
          <span>合规提醒：产品为食品，资料里不要写疾病治疗、疗效、绝对化或承诺性表述；这类内容会被合规检查拦下。</span>
        </Banner>
      </Dialog>

      <ImportReviewDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(text, importedFiles) => {
          setFeedback({ tone: 'success', text });
          setLastImported(importedFiles);
          refresh();
          void queryClient.invalidateQueries({ queryKey: ['knowledge', 'brands'] });
        }}
      />

      <Dialog
        open={Boolean(pendingDelete)}
        title="删除品牌资料"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => pendingDelete && remove.mutate(pendingDelete)}>
              确认删除
            </Button>
          </>
        }
      >
        <span>删除为软删除（保留审计记录）。若不希望被 AI 引用但想留档，建议改用「停用」。确定删除「{pendingDelete?.title}」吗？</span>
      </Dialog>
    </>
  );
}
