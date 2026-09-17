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
import { knowledgeApi } from '../../../lib/api/endpoints';
import type { KnowledgeItem } from '../../../lib/api/types';
import { formatDateTime } from '../../../lib/format';
import { KnowledgeIcon, PlusIcon } from '../../../lib/icons';
import styles from './page.module.css';

const CATEGORY_LABELS: Record<string, string> = {
  brand: '品牌定位',
  product: '产品卖点',
  ingredient: '成分说明',
  compliance: '合规红线',
  faq: '常见问答',
  tone: '话术基调',
};

const CATEGORY_TONES: Record<string, 'brand' | 'info' | 'success' | 'danger' | 'warning' | 'default'> = {
  brand: 'brand',
  product: 'success',
  ingredient: 'info',
  compliance: 'danger',
  faq: 'warning',
  tone: 'default',
};

type KnowledgeCategory = KnowledgeItem['category'];

interface ImportProgress {
  name: string;
  size: number;
  status: 'pending' | 'running' | 'ok' | 'fail';
  message: string;
  ids: string[];
  chunks: number;
}

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
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importForm, setImportForm] = useState({ brand: '', category: 'brand', priority: 6, autoActivate: false });
  const [progress, setProgress] = useState<ImportProgress[]>([]);
  const [importing, setImporting] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);

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
    category: form.category,
    title: form.title.trim(),
    content: form.content,
    tags: form.tagsText.split(/[、,，\s]+/).map((tag) => tag.trim()).filter(Boolean),
    keywords: form.keywordsText.split(/[、,，\s]+/).map((word) => word.trim()).filter(Boolean),
    priority: Number(form.priority) || 0,
  };

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

  const runImport = async (): Promise<void> => {
    const queue: ImportProgress[] = importFiles.map((file) => ({
      name: file.name,
      size: file.size,
      status: 'pending',
      message: '等待处理',
      ids: [],
      chunks: 0,
    }));
    setProgress(queue);
    setImporting(true);

    const createdIds: string[] = [];
    for (let index = 0; index < importFiles.length; index += 1) {
      const file = importFiles[index];
      setProgress((prev) => prev.map((item, position) => (position === index ? { ...item, status: 'running', message: '解析中…' } : item)));
      try {
        const result = await knowledgeApi.importDocument(file, {
          brand: importForm.brand.trim(),
          category: importForm.category,
          priority: Number(importForm.priority) || 0,
          autoActivate: importForm.autoActivate,
        });
        createdIds.push(...result.created.map((item) => item.id));
        setProgress((prev) =>
          prev.map((item, position) =>
            position === index
              ? {
                  ...item,
                  status: 'ok',
                  chunks: result.created.length,
                  ids: result.created.map((entry) => entry.id),
                  message: `${result.parsed.charCount} 字 → ${result.created.length} 条${result.created[0]?.isActive ? '（已启用）' : '草稿'}${
                    result.parsed.ocrSections ? ` · 含 ${result.parsed.ocrSections} 段图片 OCR` : ''
                  }${result.parsed.warnings.length ? ` · ${result.parsed.warnings[0]}` : ''}`,
                }
              : item,
          ),
        );
      } catch (error) {
        setProgress((prev) =>
          prev.map((item, position) =>
            position === index
              ? { ...item, status: 'fail', message: error instanceof ApiError ? error.message : '解析失败' }
              : item,
          ),
        );
      }
    }

    setImporting(false);
    refresh();
    void queryClient.invalidateQueries({ queryKey: ['knowledge', 'brands'] });
  };

  const activateImported = useMutation({
    mutationFn: (ids: string[]) => knowledgeApi.batchActivate(ids, true),
    onSuccess: (result) => {
      setFeedback({ tone: 'success', text: `已启用 ${result.updated} 条资料，AI 生成时会引用` });
      setImportOpen(false);
      setImportFiles([]);
      setProgress([]);
      refresh();
    },
    onError: (error: unknown) => onError(error, '启用失败'),
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
          <span className={styles.titleStrong}>{row.title}</span>
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
          <Tag tone={CATEGORY_TONES[row.category] ?? 'default'}>{CATEGORY_LABELS[row.category] ?? row.category}</Tag>
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
          <Button variant="text" size="sm" onClick={() => { setEditing(row); setFormOpen(true); }}>
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
          规则：AI 做多平台适配时，会按内容的标题/正文/标签与这里的「标签 + 关键词」匹配，取优先级最高的若干条（默认 5 条）拼进提示词；被引用的资料会累加「被引用次数」，方便识别哪些资料真正有用。停用的资料不参与匹配。
        </span>
      </Banner>

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
              options={[{ value: '', label: '全部分类' }, ...Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))]}
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
            <Button variant="secondary" onClick={() => { setImportOpen(true); setImportFiles([]); setProgress([]); }}>
              导入文档
            </Button>
            <Button icon={<PlusIcon width={16} height={16} />} onClick={() => { setEditing(null); setForm(EMPTY_FORM); setFormOpen(true); }}>
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
          <div className={styles.twoCol}>
            <Input label="品牌" name="brand" required placeholder="例如：卿尔美" value={form.brand} onChange={(event) => setForm({ ...form, brand: event.target.value })} />
            <Select
              label="分类"
              name="category"
              options={Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
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

      <Dialog
        open={importOpen}
        title="导入文档到知识库"
        onClose={() => setImportOpen(false)}
        footer={
          progress.length > 0 ? (
            <>
              <Button variant="secondary" onClick={() => setImportOpen(false)}>
                稍后确认
              </Button>
              <Button
                loading={activateImported.isPending}
                disabled={importForm.autoActivate || progress.every((item) => item.ids.length === 0)}
                onClick={() =>
                  activateImported.mutate(progress.flatMap((item) => item.ids))
                }
              >
                全部启用（{progress.reduce((total, item) => total + item.ids.length, 0)} 条）
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setImportOpen(false)}>
                取消
              </Button>
              <Button
                loading={importing}
                disabled={importFiles.length === 0 || !importForm.brand.trim()}
                onClick={() => void runImport()}
              >
                解析并入库（{importFiles.length || 0} 个文件）
              </Button>
            </>
          )
        }
      >
        {progress.length > 0 ? (
          <div className={styles.form}>
            <Banner tone={progress.some((item) => item.status === 'fail') ? 'warning' : 'info'}>
              <span>
                共 {progress.length} 个文件：成功 {progress.filter((item) => item.status === 'ok').length} 个，
                失败 {progress.filter((item) => item.status === 'fail').length} 个，
                生成草稿/资料 {progress.reduce((total, item) => total + item.ids.length, 0)} 条
                {importForm.autoActivate ? '（已直接启用）' : '（默认停用，确认后启用）'}。
              </span>
            </Banner>
            <div style={{ maxHeight: '16rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--mf-space-2)' }}>
              {progress.map((item) => (
                <div key={item.name} className={styles.variantItem}>
                  <div style={{ display: 'flex', gap: 'var(--mf-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Tag tone={item.status === 'ok' ? 'success' : item.status === 'fail' ? 'danger' : item.status === 'running' ? 'warning' : 'default'}>
                      {item.status === 'ok' ? '成功' : item.status === 'fail' ? '失败' : item.status === 'running' ? '处理中' : '等待'}
                    </Tag>
                    <span className={styles.titleStrong}>{item.name}</span>
                    <span className={styles.meta}>{(item.size / 1024).toFixed(0)} KB</span>
                  </div>
                  <span className={styles.preview}>{item.message}</span>
                </div>
              ))}
            </div>
            <Banner tone="warning">
              <span>建议抽查几条内容，确认没有解析错乱再启用；也可以在列表里逐条编辑标签、关键词后再启用。</span>
            </Banner>
          </div>
        ) : (
          <div className={styles.form}>
            <label className={styles.filePicker}>
              <input
                type="file"
                multiple
                accept=".pdf,.docx,.pptx,.xlsx,.xls,.csv,.txt,.md,.markdown"
                onChange={(event) => {
                  setImportFiles(Array.from(event.target.files ?? []));
                  setProgress([]);
                }}
              />
              <span>
                {importFiles.length > 0
                  ? `已选 ${importFiles.length} 个文件（合计 ${(importFiles.reduce((total, file) => total + file.size, 0) / 1024 / 1024).toFixed(1)} MB）`
                  : '选择文件，可多选（PDF / Word / PPT / Excel / CSV / txt / md，单个 ≤10MB）'}
              </span>
            </label>
            {importFiles.length > 0 ? (
              <div style={{ maxHeight: '7rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--mf-space-1)' }}>
                {importFiles.map((file) => (
                  <span key={file.name} className={styles.meta}>
                    • {file.name}（{(file.size / 1024).toFixed(0)} KB）
                  </span>
                ))}
              </div>
            ) : null}
            <div className={styles.twoCol}>
              <Input label="品牌" name="importBrand" required placeholder="例如：卿尔美" value={importForm.brand} onChange={(event) => setImportForm({ ...importForm, brand: event.target.value })} />
              <Select
                label="分类"
                name="importCategory"
                options={Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
                value={importForm.category}
                onChange={(event) => setImportForm({ ...importForm, category: event.target.value })}
              />
            </div>
            <div className={styles.twoCol}>
              <Input
                label="优先级（0-100）"
                name="importPriority"
                type="number"
                value={String(importForm.priority)}
                onChange={(event) => setImportForm({ ...importForm, priority: Number(event.target.value) })}
              />
              <Select
                label="入库方式"
                name="importActivate"
                options={[
                  { value: 'false', label: '生成草稿，人工确认后启用（推荐）' },
                  { value: 'true', label: '解析后直接启用' },
                ]}
                value={importForm.autoActivate ? 'true' : 'false'}
                onChange={(event) => setImportForm({ ...importForm, autoActivate: event.target.value === 'true' })}
              />
            </div>
            <Banner tone="info">
              <span>
                系统会按段落自动切片（每片约 1200 字、带重叠），一片 = 一条资料；原文件会留档便于追溯。
                <strong>PPT/Word 里的图片文字会用本地 OCR 识别（离线运行、不调用 AI 接口）</strong>，扫描版 PDF 也会自动走 OCR。
              </span>
            </Banner>
          </div>
        )}
      </Dialog>

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
