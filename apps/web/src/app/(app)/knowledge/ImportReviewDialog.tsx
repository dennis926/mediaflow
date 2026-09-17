'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Input, Select, Textarea } from '../../../components/ui/Field';
import { Tag } from '../../../components/ui/Tag';
import { ApiError } from '../../../lib/api/client';
import { knowledgeApi } from '../../../lib/api/endpoints';
import { CATEGORY_LABELS, IMPORT_ACCEPT } from '../../../lib/knowledge';
import styles from './page.module.css';

type Category = 'brand' | 'product' | 'ingredient' | 'compliance' | 'faq' | 'tone';

interface ReviewChunk {
  key: string;
  content: string;
  fromOcr: boolean;
}

interface ReviewFile {
  key: string;
  name: string;
  size: number;
  status: 'parsing' | 'ready' | 'failed' | 'saving' | 'saved';
  message: string;
  charCount: number;
  ocrSections: number;
  warnings: string[];
  tempFile: string;
  chunks: ReviewChunk[];
  originals: ReviewChunk[];
}

export interface ImportReviewDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (message: string, importedFiles: string[]) => void;
}

const CHUNK_LIMIT = 1200;
const CHUNK_OVERLAP = 200;
const MIN_CHUNK_CHARS = 20;

let sequence = 0;
const nextKey = (): string => {
  sequence += 1;
  return `chunk-${sequence}`;
};

/** 校对台里的"拆分"：按空行重新聚合成 ~1200 字一片，与后端切片规则一致。 */
function splitIntoChunks(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const pieces: string[] = [];
  let buffer = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_LIMIT) {
      if (buffer) {
        pieces.push(buffer);
        buffer = '';
      }
      for (let start = 0; start < paragraph.length; start += CHUNK_LIMIT - CHUNK_OVERLAP) {
        pieces.push(paragraph.slice(start, start + CHUNK_LIMIT));
      }
      continue;
    }
    if ((buffer + '\n' + paragraph).length > CHUNK_LIMIT) {
      pieces.push(buffer);
      buffer = paragraph;
    } else {
      buffer = buffer ? `${buffer}\n${paragraph}` : paragraph;
    }
  }
  if (buffer) pieces.push(buffer);
  return pieces.filter((piece) => piece.trim().length >= MIN_CHUNK_CHARS);
}

/**
 * 文档导入的"两段式"流程：
 * 1. 选择文件 → 后端只解析、不入库；
 * 2. 复核校对台：逐片可编辑/删除/合并/重新拆分，OCR 文字单独标注 → 点"确认无误"才真正入库。
 * 这样 OCR 错字能在入库前改掉，也不会因为一次误上传就产生一堆垃圾资料。
 */
export function ImportReviewDialog({ open, onClose, onImported }: ImportReviewDialogProps) {
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<'select' | 'review'>('select');
  const [files, setFiles] = useState<File[]>([]);
  const [reviews, setReviews] = useState<ReviewFile[]>([]);
  const [activeKey, setActiveKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState({ brand: '', category: 'brand' as Category, priority: 6, activate: true });

  const active = reviews.find((item) => item.key === activeKey) ?? reviews[0];
  const readyFiles = reviews.filter((item) => item.status === 'ready');
  const failedFiles = reviews.filter((item) => item.status === 'failed');
  const activeChunks = active?.chunks ?? [];

  const patchReview = (key: string, patch: Partial<ReviewFile>): void => {
    setReviews((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  };

  const reset = (): void => {
    setStage('select');
    setFiles([]);
    setReviews([]);
    setActiveKey('');
    setError('');
    setBusy(false);
  };

  const close = (): void => {
    reset();
    onClose();
  };

  /** 第一步：逐个文件解析（只读，不写库），一个文件失败不影响其它文件。 */
  const startParse = async (): Promise<void> => {
    setBusy(true);
    setError('');
    const queue: ReviewFile[] = [];

    for (const file of files) {
      const placeholder: ReviewFile = {
        key: `${file.name}-${file.size}-${nextKey()}`,
        name: file.name,
        size: file.size,
        status: 'parsing',
        message: '正在解析…',
        charCount: 0,
        ocrSections: 0,
        warnings: [],
        tempFile: '',
        chunks: [],
        originals: [],
      };
      queue.push(placeholder);
      setReviews([...queue]);

      try {
        const result = await knowledgeApi.parseDocument(file);
        const chunks = result.chunks.map((chunk) => ({ key: nextKey(), content: chunk.content, fromOcr: chunk.fromOcr }));
        queue[queue.length - 1] = {
          ...placeholder,
          status: 'ready',
          message: `${result.parsed.charCount} 字 → ${chunks.length} 片待校对`,
          charCount: result.parsed.charCount,
          ocrSections: result.parsed.ocrSections ?? 0,
          warnings: result.parsed.warnings,
          tempFile: result.tempFile,
          chunks,
          originals: chunks.map((chunk) => ({ ...chunk })),
        };
      } catch (caught) {
        queue[queue.length - 1] = {
          ...placeholder,
          status: 'failed',
          message: caught instanceof ApiError ? caught.message : '解析失败',
        };
      }
      setReviews([...queue]);
    }

    setActiveKey(queue.find((item) => item.status === 'ready')?.key ?? queue[0]?.key ?? '');
    setBusy(false);
    setStage('review');
  };

  /** 第三步：以人工校对后的分片入库。 */
  const commit = async (keys: string[]): Promise<void> => {
    if (!settings.brand.trim()) {
      setError('请先填写品牌');
      return;
    }
    setBusy(true);
    setError('');
    let totalCreated = 0;
    let succeeded = 0;
    const importedFiles: string[] = [];

    for (const key of keys) {
      const target = reviews.find((item) => item.key === key);
      if (!target || target.status !== 'ready') continue;
      const payloadChunks = target.chunks
        .filter((chunk) => chunk.content.trim().length >= MIN_CHUNK_CHARS)
        .map((chunk) => ({ content: chunk.content.trim(), fromOcr: chunk.fromOcr }));
      if (payloadChunks.length === 0) {
        patchReview(key, { status: 'failed', message: '没有可入库的内容（每片至少 20 字）' });
        continue;
      }

      patchReview(key, { status: 'saving', message: '正在入库…' });
      try {
        const result = await knowledgeApi.commitImport({
          brand: settings.brand.trim(),
          category: settings.category,
          priority: Number(settings.priority) || 0,
          activate: settings.activate,
          sourceFileName: target.name,
          tempFile: target.tempFile || undefined,
          chunks: payloadChunks,
        });
        totalCreated += result.created.length;
        succeeded += 1;
        importedFiles.push(target.name);
        patchReview(key, { status: 'saved', message: `已入库 ${result.created.length} 条${settings.activate ? '（启用中）' : '（草稿）'}` });
      } catch (caught) {
        patchReview(key, { status: 'failed', message: caught instanceof ApiError ? caught.message : '入库失败' });
      }
    }

    setBusy(false);
    if (succeeded > 0) {
      onImported(`已录入 ${totalCreated} 条资料（人工已校对）`, importedFiles);
      void queryClient.invalidateQueries({ queryKey: ['knowledge'] });
      if (reviews.every((item) => item.status !== 'ready')) close();
    }
  };

  const editChunk = (key: string, content: string): void => {
    if (!active) return;
    patchReview(active.key, { chunks: active.chunks.map((chunk) => (chunk.key === key ? { ...chunk, content } : chunk)) });
  };

  const removeChunk = (key: string): void => {
    if (!active) return;
    patchReview(active.key, { chunks: active.chunks.filter((chunk) => chunk.key !== key) });
  };

  const mergeIntoPrevious = (index: number): void => {
    if (!active || index === 0) return;
    const merged = [...active.chunks];
    const previous = merged[index - 1];
    merged[index - 1] = { ...previous, content: `${previous.content}\n\n${merged[index].content}` };
    merged.splice(index, 1);
    patchReview(active.key, { chunks: merged });
  };

  const splitChunk = (index: number): void => {
    if (!active) return;
    const target = active.chunks[index];
    const pieces = splitIntoChunks(target.content);
    if (pieces.length <= 1) return;
    const rebuilt = [...active.chunks];
    rebuilt.splice(index, 1, ...pieces.map((content) => ({ key: nextKey(), content, fromOcr: target.fromOcr })));
    patchReview(active.key, { chunks: rebuilt });
  };

  const restoreOriginal = (): void => {
    if (!active) return;
    patchReview(active.key, { chunks: active.originals.map((chunk) => ({ ...chunk })) });
  };

  const footer =
    stage === 'select' ? (
      <>
        <Button variant="secondary" onClick={close}>
          取消
        </Button>
        <Button loading={busy} disabled={files.length === 0} onClick={() => void startParse()}>
          解析并校对（{files.length} 个文件）
        </Button>
      </>
    ) : (
      <>
        <Button variant="secondary" onClick={reset} disabled={busy}>
          重新选文件
        </Button>
        {readyFiles.length > 1 ? (
          <Button variant="secondary" loading={busy} onClick={() => void commit(readyFiles.map((item) => item.key))}>
            全部确认入库（{readyFiles.length} 个文件）
          </Button>
        ) : null}
        <Button
          loading={busy}
          disabled={!active || active.status !== 'ready' || !settings.brand.trim() || active.chunks.length === 0}
          onClick={() => active && void commit([active.key])}
        >
          确认无误，录入知识库
        </Button>
      </>
    );

  return (
    <Dialog open={open} title={stage === 'select' ? '导入文档到知识库' : '复核校对（确认后才入库）'} onClose={close} footer={footer}>
      {error ? <Banner tone="danger">{error}</Banner> : null}

      {stage === 'select' ? (
        <div className={styles.form}>
          <label className={styles.filePicker}>
            <input
              type="file"
              multiple
              accept={IMPORT_ACCEPT}
              onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
            />
            <span>
              {files.length > 0
                ? `已选 ${files.length} 个文件（合计 ${(files.reduce((total, file) => total + file.size, 0) / 1024 / 1024).toFixed(1)} MB）`
                : '选择文件，可多选（PDF / Word / PPT / Excel / CSV / txt / md，单个 ≤10MB）'}
            </span>
          </label>
          {files.length > 0 ? (
            <div className={styles.fileList}>
              {files.map((file) => (
                <span key={`${file.name}-${file.lastModified}`} className={styles.meta}>
                  • {file.name}（{(file.size / 1024).toFixed(0)} KB）
                </span>
              ))}
            </div>
          ) : null}
          <div className={styles.twoCol}>
            <Input label="品牌" name="importBrand" required placeholder="例如：品牌名称" value={settings.brand} onChange={(event) => setSettings({ ...settings, brand: event.target.value })} />
            <Select
              label="分类"
              name="importCategory"
              options={Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
              value={settings.category}
              onChange={(event) => setSettings({ ...settings, category: event.target.value as Category })}
            />
          </div>
          <Banner tone="info">
            <span>
              点「解析并校对」后<strong>只会解析、不会入库</strong>：系统先按段落切片（每片约 1200 字、带重叠），
              你在下一步逐片核对修改，点「确认无误」才写入知识库。PPT/Word 里的图片文字、扫描版 PDF 会用
              <strong>本地 OCR</strong>识别（离线运行、不调用 AI 接口），识别结果会单独标注出来。
            </span>
          </Banner>
        </div>
      ) : (
        <div className={styles.form}>
          <div className={styles.tabs}>
            {reviews.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`${styles.tab} ${item.key === active?.key ? styles.tabActive : ''}`}
                onClick={() => setActiveKey(item.key)}
              >
                <span className={styles.tabName}>{item.name}</span>
                <Tag tone={item.status === 'ready' ? 'info' : item.status === 'failed' ? 'danger' : 'success'}>
                  {item.status === 'ready' ? '待校对' : item.status === 'failed' ? '失败' : item.status === 'parsing' ? '解析中' : item.status === 'saving' ? '入库中' : '已入库'}
                </Tag>
              </button>
            ))}
          </div>

          {failedFiles.length > 0 ? (
            <Banner tone="warning">
              {failedFiles.map((item) => (
                <div key={item.key}>
                  解析失败：{item.name} —— {item.message}
                </div>
              ))}
            </Banner>
          ) : null}

          {active ? (
            <>
              <div className={styles.reviewSummary}>
                <span className={styles.titleStrong}>{active.name}</span>
                <span className={styles.meta}>
                  {(active.size / 1024).toFixed(0)} KB · {active.charCount} 字 · {activeChunks.length} 片
                  {active.ocrSections > 0 ? ` · 本地 OCR 识别 ${active.ocrSections} 张图片/页` : ''}
                </span>
                <span className={styles.meta}>{active.message}</span>
              </div>

              {active.warnings.map((warning) => (
                <Banner key={warning} tone="warning">
                  <span>{warning}</span>
                </Banner>
              ))}

              {activeChunks.some((chunk) => chunk.fromOcr) ? (
                <Banner tone="warning">
                  <span>
                    标有「图片识别」的片段来自本地 OCR，<strong>数字、规格、单位最容易认错</strong>，请重点核对后再入库（例如「8 克」被认成「3 克」）。
                  </span>
                </Banner>
              ) : null}

              <div className={styles.twoCol}>
                <Input label="品牌" name="reviewBrand" required value={settings.brand} onChange={(event) => setSettings({ ...settings, brand: event.target.value })} />
                <Select
                  label="分类"
                  name="reviewCategory"
                  options={Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
                  value={settings.category}
                  onChange={(event) => setSettings({ ...settings, category: event.target.value as Category })}
                />
              </div>
              <div className={styles.twoCol}>
                <Input
                  label="优先级（0-100，越大越优先被引用）"
                  name="reviewPriority"
                  type="number"
                  value={String(settings.priority)}
                  onChange={(event) => setSettings({ ...settings, priority: Number(event.target.value) })}
                />
                <Select
                  label="入库方式"
                  name="reviewActivate"
                  hint="已人工校对过，可直接启用"
                  options={[
                    { value: 'true', label: '确认后直接启用（AI 可引用）' },
                    { value: 'false', label: '先存草稿，稍后再启用' },
                  ]}
                  value={settings.activate ? 'true' : 'false'}
                  onChange={(event) => setSettings({ ...settings, activate: event.target.value === 'true' })}
                />
              </div>

              <div className={styles.reviewToolbar}>
                <span className={styles.meta}>逐片校对：可直接修改文字；无需保留的片段可删除，或合并成一条。</span>
                <Button variant="text" size="sm" onClick={restoreOriginal} disabled={busy}>
                  还原为原始解析结果
                </Button>
              </div>

              <div className={styles.chunkList}>
                {activeChunks.map((chunk, index) => (
                  <div key={chunk.key} className={styles.chunkCard}>
                    <div className={styles.chunkHead}>
                      <span className={styles.chunkIndex}>第 {index + 1} 片</span>
                      <Tag tone="default">{chunk.content.trim().length} 字</Tag>
                      {chunk.fromOcr ? <Tag tone="warning">图片识别，重点核对</Tag> : null}
                      <span className={styles.spacer}>
                        <Button variant="text" size="sm" disabled={index === 0 || busy} onClick={() => mergeIntoPrevious(index)}>
                          合并到上一片
                        </Button>
                        <Button variant="text" size="sm" disabled={busy} onClick={() => splitChunk(index)}>
                          按段落拆分
                        </Button>
                        <Button variant="text" size="sm" disabled={busy} onClick={() => removeChunk(chunk.key)}>
                          删除
                        </Button>
                      </span>
                    </div>
                    <Textarea
                      name={`chunk-${chunk.key}`}
                      value={chunk.content}
                      rows={Math.min(14, Math.max(4, Math.ceil(chunk.content.length / 60)))}
                      onChange={(event) => editChunk(chunk.key, event.target.value)}
                    />
                  </div>
                ))}
                {activeChunks.length === 0 ? (
                  <Banner tone="warning">
                    <span>这一份文件的分片都被删除了，请「还原为原始解析结果」或返回重新选择文件。</span>
                  </Banner>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
