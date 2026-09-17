'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { Input, Select } from '../../../components/ui/Field';
import { ApiError } from '../../../lib/api/client';
import { knowledgeApi } from '../../../lib/api/endpoints';
import type { KnowledgeImportPreview } from '../../../lib/api/types';
import { useKnowledgeCategories } from '../../../lib/knowledge';
import { SparkleIcon } from '../../../lib/icons';
import styles from './page.module.css';

const TARGETS = [
  { key: 'title', label: '标题' },
  { key: 'content', label: '正文（必填）' },
  { key: 'brand', label: '品牌' },
  { key: 'category', label: '分类' },
  { key: 'tags', label: '标签' },
  { key: 'keywords', label: '关键词' },
  { key: 'priority', label: '优先级' },
  { key: 'isActive', label: '是否启用' },
] as const;

type Target = (typeof TARGETS)[number]['key'];

/**
 * 知识库导入导出。
 * - 导出：json（原生，含分类配置，可整站迁移）/ csv / markdown
 * - 导入：兼容其他系统导出的 CSV / Excel / Markdown / JSON，字段名自动识别，识别不准可以手动改映射
 */
export function TransferPanel() {
  const queryClient = useQueryClient();
  const { categories } = useKnowledgeCategories();
  const brandsQuery = useQuery({ queryKey: ['knowledge', 'brands'], queryFn: () => knowledgeApi.brands() });
  const [format, setFormat] = useState<'json' | 'csv' | 'markdown'>('json');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [scopeBrand, setScopeBrand] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);

  const [preview, setPreview] = useState<KnowledgeImportPreview | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<Target, string>>>({});
  const [defaults, setDefaults] = useState({ brand: '', category: '', priority: 0, isActive: true, skipDuplicates: true, applyCategories: false });

  const exportRun = useMutation({
    mutationFn: () => knowledgeApi.exportData({ format, brand: scopeBrand || undefined, includeInactive }),
    onSuccess: (file) => {
      const blob = new Blob([file.content], { type: file.mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      setFeedback({ tone: 'success', text: `已导出 ${file.fileName}` });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '导出失败' }),
  });

  const previewRun = useMutation({
    mutationFn: (file: File) => knowledgeApi.previewImportData(file),
    onSuccess: (result) => {
      setPreview(result);
      setMapping(result.mapping as Partial<Record<Target, string>>);
      setDefaults((prev) => ({
        ...prev,
        category: prev.category || categories[0]?.code || 'product',
        applyCategories: false,
      }));
      setFeedback({ tone: 'info', text: `已解析 ${result.fileName}：共 ${result.total} 行，字段映射已自动识别，请核对后导入` });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '解析失败' }),
  });

  const commitRun = useMutation({
    mutationFn: () =>
      knowledgeApi.commitImportData({
        rows: preview?.rows ?? [],
        mapping: mapping as Record<string, string | undefined>,
        brand: defaults.brand.trim(),
        category: defaults.category,
        priority: defaults.priority,
        isActive: defaults.isActive,
        skipDuplicates: defaults.skipDuplicates,
        sourceFileName: preview?.fileName,
      }),
    onSuccess: (result) => {
      setFeedback({
        tone: 'success',
        text: `导入完成：新增 ${result.created} 条，跳过重复 ${result.duplicates} 条${result.skipped.length ? `，忽略无效 ${result.skipped.length} 行` : ''}`,
      });
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: ['knowledge'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '导入失败' }),
  });

  const previewColumns: Array<Column<Record<string, string>>> = (preview?.columns ?? []).slice(0, 6).map((column) => ({
    key: column,
    title: column,
    render: (row) => <span className={styles.preview}>{(row[column] ?? '').slice(0, 60)}</span>,
  }));

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
        <div className={styles.sectionHead}>
          <span className={styles.titleStrong}>导出知识库</span>
          <span className={styles.meta}>备份、迁移到别的系统，或交给别的公司复用</span>
        </div>
        <div className={styles.form}>
          <div className={styles.twoCol}>
            <Select
              label="导出格式"
              name="exportFormat"
              options={[
                { value: 'json', label: 'JSON（原生格式，含分类配置，可整站迁移）' },
                { value: 'csv', label: 'CSV（Excel 可打开，通用交换）' },
                { value: 'markdown', label: 'Markdown（人可读，便于导入其他工具）' },
              ]}
              value={format}
              onChange={(event) => setFormat(event.target.value as 'json' | 'csv' | 'markdown')}
            />
            <Select
              label="只导出某个品牌"
              name="exportBrand"
              options={[
                { value: '', label: '全部品牌' },
                ...(brandsQuery.data ?? []).map((item) => ({ value: item.brand, label: `${item.brand}（${item.count}）` })),
              ]}
              value={scopeBrand}
              onChange={(event) => setScopeBrand(event.target.value)}
            />
          </div>
          <div className={styles.reviewToolbar}>
            <Select
              label="停用的资料"
              name="exportInactive"
              options={[
                { value: 'false', label: '不导出停用资料' },
                { value: 'true', label: '一并导出（含停用）' },
              ]}
              value={includeInactive ? 'true' : 'false'}
              onChange={(event) => setIncludeInactive(event.target.value === 'true')}
            />
            <Button icon={<SparkleIcon width={15} height={15} />} loading={exportRun.isPending} onClick={() => exportRun.mutate()}>
              导出并下载
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className={styles.sectionHead}>
          <span className={styles.titleStrong}>导入知识库</span>
          <span className={styles.meta}>
            支持其他系统导出的内容：CSV / Excel / Markdown / JSON（中文表头、英文表头、GBK 编码都能识别）
          </span>
        </div>
        <div className={styles.form}>
          <label className={styles.filePicker}>
            <input
              type="file"
              accept=".json,.csv,.tsv,.xlsx,.xls,.md,.markdown,.txt"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) previewRun.mutate(file);
              }}
            />
            <span>{preview ? `已解析：${preview.fileName}（${preview.total} 行）` : '选择要导入的文件（表格 / Markdown / JSON）'}</span>
          </label>

          {preview ? (
            <>
              {preview.warnings.map((warning) => (
                <Banner key={warning} tone="warning">
                  <span>{warning}</span>
                </Banner>
              ))}

              <div className={styles.twoCol}>
                <Input
                  label="默认品牌（行里没有品牌时用）"
                  name="importBrand"
                  required
                  placeholder="例如：品牌名称"
                  value={defaults.brand}
                  onChange={(event) => setDefaults({ ...defaults, brand: event.target.value })}
                />
                <Select
                  label="默认分类（行里没有分类时用）"
                  name="importCategory"
                  options={categories.map((item) => ({ value: item.code, label: item.label }))}
                  value={defaults.category}
                  onChange={(event) => setDefaults({ ...defaults, category: event.target.value })}
                />
              </div>

              <div className={styles.sectionHead}>
                <span className={styles.titleStrong}>字段映射</span>
                <span className={styles.meta}>已自动识别，错了在这里改：左边是我们的字段，右边选文件里的列</span>
              </div>
              <div className={styles.twoCol}>
                {TARGETS.map((target) => (
                  <Select
                    key={target.key}
                    label={target.label}
                    name={`map-${target.key}`}
                    options={[{ value: '', label: '（不使用）' }, ...preview.columns.map((column) => ({ value: column, label: column }))]}
                    value={mapping[target.key] ?? ''}
                    onChange={(event) => setMapping({ ...mapping, [target.key]: event.target.value || undefined })}
                  />
                ))}
              </div>

              <div className={styles.reviewToolbar}>
                <Input label="默认优先级" name="importPriority" type="number" value={String(defaults.priority)} onChange={(event) => setDefaults({ ...defaults, priority: Number(event.target.value) })} />
                <Select
                  label="入库后的状态"
                  name="importActive"
                  options={[
                    { value: 'true', label: '直接启用' },
                    { value: 'false', label: '先停用（人工确认后再启用）' },
                  ]}
                  value={defaults.isActive ? 'true' : 'false'}
                  onChange={(event) => setDefaults({ ...defaults, isActive: event.target.value === 'true' })}
                />
                <Select
                  label="重复内容"
                  name="importSkipDuplicates"
                  options={[
                    { value: 'true', label: '跳过（推荐，避免重复导入）' },
                    { value: 'false', label: '照常导入（会新增重复条目）' },
                  ]}
                  value={defaults.skipDuplicates ? 'true' : 'false'}
                  onChange={(event) => setDefaults({ ...defaults, skipDuplicates: event.target.value === 'true' })}
                />
              </div>

              <div className={styles.sectionHead}>
                <span className={styles.titleStrong}>数据预览（前 5 行）</span>
                <span className={styles.meta}>共 {preview.total} 行，导入时按上面的映射逐行解析</span>
              </div>
              <DataTable columns={previewColumns} rows={preview.preview} rowKey={(row) => JSON.stringify(row).slice(0, 40)} empty={<span className={styles.meta}>没有预览数据</span>} />

              <div className={styles.reviewToolbar}>
                <Button variant="secondary" onClick={() => setPreview(null)}>
                  取消
                </Button>
                <Button loading={commitRun.isPending} disabled={!defaults.brand.trim()} onClick={() => commitRun.mutate()}>
                  确认导入 {preview.total} 行
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </Card>
    </>
  );
}
