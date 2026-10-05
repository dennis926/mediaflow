'use client';

/**
 * 内容编辑器（新建/编辑共用一份实现）。
 * 之前 new 与 [id]/edit 各自复制了一份 600 行代码，改一处漏一处，这里合并成单一来源。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AiFlagType, ContentStatus, PLATFORM_LABELS, PlatformCode } from '@mediaflow/shared';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Dialog } from '../ui/Dialog';
import { EmptyState } from '../ui/EmptyState';
import { Input, Select, Textarea } from '../ui/Field';
import { SkeletonRows } from '../ui/Skeleton';
import { Tag } from '../ui/Tag';
import { ApiError } from '../../lib/api/client';
import { aiApi, contentApi, knowledgeApi, publishApi, reviewsApi } from '../../lib/api/endpoints';
import type { ComplianceReport, KnowledgeMatchItem } from '../../lib/api/types';
import { AI_FLAG_LABELS, CONTENT_STATUS_LABELS, formatDateTime } from '../../lib/format';
import { MediaPicker } from '../media/MediaPicker';
import { templatesApi } from '../../lib/api/endpoints';
import { CheckIcon, PlusIcon, SparkleIcon, TrashIcon, WarningIcon } from '../../lib/icons';
import styles from '../../app/(app)/content/page.module.css';

const STATUS_OPTIONS = Object.values(ContentStatus).map((status) => ({
  value: status,
  label: CONTENT_STATUS_LABELS[status],
}));

const AI_FLAG_OPTIONS = Object.values(AiFlagType).map((flag) => ({ value: flag, label: AI_FLAG_LABELS[flag] }));

const PREVIEW_PLATFORMS = [PlatformCode.WechatMp, PlatformCode.Xiaohongshu, PlatformCode.Douyin];
const BODY_LIMITS: Partial<Record<PlatformCode, number>> = {
  [PlatformCode.WechatMp]: 20000,
  [PlatformCode.Xiaohongshu]: 1000,
  [PlatformCode.Douyin]: 2000,
  [PlatformCode.Zhihu]: 5000,
};

interface FormState {
  title: string;
  summary: string;
  body: string;
  tagsText: string;
  coverUrl: string;
  /** 平台发布用的图片/视频外链（来自素材库） */
  mediaUrls: string[];
  status: ContentStatus;
  aiFlagType: AiFlagType;
}

const EMPTY_FORM: FormState = {
  title: '',
  summary: '',
  body: '',
  tagsText: '',
  coverUrl: '',
  mediaUrls: [],
  status: ContentStatus.Draft,
  aiFlagType: AiFlagType.None,
};

export function ContentEditor({ mode, templateId }: { mode: 'new' | 'edit'; templateId?: string | null }): React.JSX.Element {
  const router = useRouter();
  /** 素材选择器：'media' 选正文素材，'cover' 选封面 */
  const [mediaPicker, setMediaPicker] = useState<'media' | 'cover' | null>(null);
  const params = useParams<{ id?: string }>();
  const queryClient = useQueryClient();
  const contentId = mode === 'edit' ? (params?.id ?? null) : null;

  /** 套用模板：把模板的标题/正文/标签填进表单，并累加模板引用次数 */
  const appliedTemplate = useMutation({
    mutationFn: (id: string) => templatesApi.use(id),
    onSuccess: (template) => {
      setForm((prev) => ({
        ...prev,
        title: template.title,
        body: template.body,
        tagsText: template.tags.join('、'),
      }));
      setFeedback({ tone: 'info', text: `已套用模板「${template.name}」，可以在此基础上修改` });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '套用模板失败' }),
  });

  useEffect(() => {
    if (mode !== 'new' || !templateId || appliedTemplate.isPending || appliedTemplate.isSuccess) return;
    appliedTemplate.mutate(templateId);
    // 只在首次拿到模板 id 时套用一次，避免重复累加引用次数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, templateId]);

  /** 版本历史（仅编辑模式加载） */
  const revisions = useQuery({
    queryKey: ['content', 'revisions', contentId],
    queryFn: () => contentApi.revisions(contentId as string),
    enabled: Boolean(contentId),
  });

  const restore = useMutation({
    mutationFn: (revisionId: string) => contentApi.restoreRevision(contentId as string, revisionId),
    onSuccess: (saved) => {
      setFeedback({ tone: 'success', text: `已回滚到历史版本，当前状态为「${CONTENT_STATUS_LABELS[saved.status] ?? saved.status}」` });
      void queryClient.invalidateQueries({ queryKey: ['content', contentId] });
      void queryClient.invalidateQueries({ queryKey: ['content', 'revisions', contentId] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '回滚失败' }),
  });

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'success' | 'danger'; text: string } | null>(null);
  const [previewPlatform, setPreviewPlatform] = useState<PlatformCode>(PlatformCode.WechatMp);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [genTopic, setGenTopic] = useState('');
  const [genPlatform, setGenPlatform] = useState<PlatformCode | ''>('');
  const [genTone, setGenTone] = useState('');
  const [genKeywords, setGenKeywords] = useState('');
  const [genBrand, setGenBrand] = useState('');
  // 生成后展示引用了哪些品牌资料，让运营知道 AI 的依据
  const [genUsed, setGenUsed] = useState<KnowledgeMatchItem[] | null>(null);
  const [adaptOpen, setAdaptOpen] = useState(false);
  const [adaptPlatforms, setAdaptPlatforms] = useState<PlatformCode[]>([PlatformCode.WechatMp]);
  const [adaptTone, setAdaptTone] = useState('');
  const [adaptOverwrite, setAdaptOverwrite] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishPlatforms, setPublishPlatforms] = useState<PlatformCode[]>([PlatformCode.WechatMp]);
  const [publishScheduledAt, setPublishScheduledAt] = useState('');
  const [compliance, setCompliance] = useState<ComplianceReport | null>(null);
  const [titleSuggestions, setTitleSuggestions] = useState<string[]>([]);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const content = useQuery({
    queryKey: ['content', contentId],
    queryFn: () => contentApi.get(contentId as string),
    enabled: Boolean(contentId),
  });

  const reviews = useQuery({
    queryKey: ['reviews', 'history', contentId],
    queryFn: () => reviewsApi.history(contentId as string),
    enabled: Boolean(contentId),
  });

  // 生成前先看这次会引用哪些品牌资料，避免"AI 自由发挥"
  const knowledgePreview = useQuery({
    queryKey: ['knowledge', 'preview', contentId],
    queryFn: () => knowledgeApi.preview(contentId as string, 5),
    enabled: Boolean(contentId) && adaptOpen,
  });

  const submitReview = useMutation({
    mutationFn: () => reviewsApi.submit(contentId as string, form.summary.trim() || undefined),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: '已提交审核，审核人会收到通知' });
      void queryClient.invalidateQueries({ queryKey: ['reviews', 'history', contentId] });
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['content', contentId] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '提交审核失败' }),
  });

  const variants = useQuery({
    queryKey: ['variants', contentId],
    queryFn: () => contentApi.variants(contentId as string),
    enabled: Boolean(contentId),
  });

  useEffect(() => {
    if (!content.data) return;
    setForm({
      title: content.data.title,
      summary: content.data.summary ?? '',
      body: content.data.body,
      tagsText: content.data.tags.join('、'),
      coverUrl: content.data.coverUrl ?? '',
      mediaUrls: content.data.mediaUrls ?? [],
      status: content.data.status,
      aiFlagType: content.data.aiFlagType,
    });
  }, [content.data]);

  const payload = useMemo(
    () => ({
      title: form.title.trim(),
      summary: form.summary.trim() || undefined,
      body: form.body,
      tags: form.tagsText
        .split(/[、,，\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      coverUrl: form.coverUrl.trim() || undefined,
      mediaUrls: form.mediaUrls,
      status: form.status,
      aiFlagType: form.aiFlagType,
    }),
    [form],
  );

  const save = useMutation({
    mutationFn: () => (contentId ? contentApi.update(contentId, payload) : contentApi.create(payload)),
    onSuccess: (saved) => {
      setFeedback({ tone: 'success', text: '内容已保存' });
      void queryClient.invalidateQueries({ queryKey: ['contents'] });
      if (!contentId) router.replace(`/content/${saved.id}/edit`);
      else {
        void queryClient.invalidateQueries({ queryKey: ['content', contentId] });
      }
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '保存失败' }),
  });

  const remove = useMutation({
    mutationFn: () => contentApi.remove(contentId as string),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['contents'] });
      router.replace('/content');
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '删除失败' }),
  });

  const flagCheck = useMutation({
    mutationFn: () => contentApi.aiFlagCheck(contentId as string, true, '在编辑器中复核'),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: 'AI 标识已复核，可创建发布任务' });
      void queryClient.invalidateQueries({ queryKey: ['content', contentId] });
    },
  });

  /**
   * AI 一键生成：从零起草，成功后直接填进表单。
   *
   * 只填表单、不自动保存——AI 产物必须经人工确认（AGENTS.md 第 5 节），
   * 且保存时后端还会做 AI 标识一致性校验。
   */
  const generate = useMutation({
    mutationFn: () =>
      contentApi.aiDraft({
        topic: genTopic.trim(),
        platform: genPlatform || undefined,
        tone: genTone.trim() || undefined,
        keywords: genKeywords
          .split(/[、,，\s]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        brand: genBrand.trim() || undefined,
      }),
    onSuccess: (result) => {
      setGenerateOpen(false);
      setGenUsed(result.knowledgeUsed ?? []);
      setForm((prev) => ({
        ...prev,
        title: result.draft.title,
        summary: result.draft.summary || prev.summary,
        body: result.draft.body,
        tagsText: result.draft.tags.join('、'),
        /**
         * 标识不自动改（用户明确要求：默认就是没有）。
         * 编辑器左栏会给出提示，是否标注由操作者自己决定。
         */
      }));
      setFeedback({
        tone: 'success',
        text: `AI 已起草，请核对事实后再保存（模型：${result.model}${
          result.knowledgeUsed?.length ? `，引用品牌资料 ${result.knowledgeUsed.length} 条` : '，未引用品牌资料'
        }）`,
      });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : 'AI 生成失败' }),
  });

  const adapt = useMutation({
    mutationFn: () =>
      contentApi.aiAdapt(contentId as string, {
        platforms: adaptPlatforms,
        tone: adaptTone.trim() || undefined,
        overwrite: adaptOverwrite,
      }),
    onSuccess: (result) => {
      setAdaptOpen(false);
      setFeedback({
        tone: 'success',
        text: `已生成 ${result.variants.length} 个平台版本${result.skipped.length ? `，跳过 ${result.skipped.length} 个已存在平台` : ''}（模型：${result.model}${
          result.knowledgeUsed?.length ? `，引用品牌资料 ${result.knowledgeUsed.length} 条` : '，未引用品牌资料'
        }）`,
      });
      void queryClient.invalidateQueries({ queryKey: ['variants', contentId] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : 'AI 适配失败' }),
  });

  const optimize = useMutation({
    mutationFn: () => aiApi.optimizeTitle({ title: form.title, keywords: payload.tags }),
    onSuccess: (result) => setTitleSuggestions(result.titles),
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '标题优化失败' }),
  });

  const checkCompliance = useMutation({
    mutationFn: () => aiApi.complianceCheck({ text: `${form.title}\n${form.body}`, useAiReview: true }),
    onSuccess: (report) => setCompliance(report),
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '合规检查失败' }),
  });

  const publish = useMutation({
    mutationFn: () =>
      publishApi.create({
        contentId: contentId as string,
        platforms: publishPlatforms,
        scheduledAt: publishScheduledAt ? new Date(publishScheduledAt).toISOString() : undefined,
      }),
    onSuccess: (tasks) => {
      setPublishOpen(false);
      const summary = tasks
        .map((task) => `${PLATFORM_LABELS[task.platform as PlatformCode]}：${task.status === 'manual_required' ? '待人工发布' : '已入队'}`)
        .join('；');
      setFeedback({
        tone: 'success',
        text: `已创建 ${tasks.length} 个发布任务（${publishScheduledAt ? '已排期' : '立即入队'}）— ${summary}`,
      });
      void queryClient.invalidateQueries({ queryKey: ['publish'] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '创建发布任务失败' }),
  });

  const limit = BODY_LIMITS[previewPlatform] ?? 5000;
  const bodyLength = form.body.length;

  if (contentId && content.isLoading) {
    return (
      <Card title="内容编辑器">
        <SkeletonRows rows={6} />
      </Card>
    );
  }

  return (
    <>
      {feedback ? (
        <Banner tone={feedback.tone}>
          {feedback.text}
          <button
            type="button"
            onClick={() => setFeedback(null)}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}
          >
            知道了
          </button>
        </Banner>
      ) : null}

      <div className={styles.layout}>
        <div className={styles.panel}>
          <Card title={contentId ? '编辑内容' : '新建内容'} extra={content.data ? <Tag tone="info">{formatDateTime(content.data.updatedAt)} 更新</Tag> : null}>
            <div className={styles.formGrid}>
              <div className={styles.fullRow}>
                <Input
                  label="标题"
                  name="title"
                  required
                  value={form.title}
                  placeholder="例如：秋季肠道健康指南"
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                />
              </div>
              <div className={styles.fullRow}>
                <Input
                  label="摘要"
                  name="summary"
                  value={form.summary}
                  placeholder="一句话概括，用于列表展示"
                  onChange={(event) => setForm({ ...form, summary: event.target.value })}
                />
              </div>
              <div className={styles.fullRow}>
                <Textarea
                  label="正文"
                  name="body"
                  required
                  className={styles.bodyArea}
                  value={form.body}
                  placeholder="写下正文内容……"
                  onChange={(event) => setForm({ ...form, body: event.target.value })}
                />
              </div>
              <div className={styles.fullRow}>
                <Input
                  label="标签"
                  name="tags"
                  value={form.tagsText}
                  placeholder="用顿号或逗号分隔，例如：肠道、膳食纤维"
                  onChange={(event) => setForm({ ...form, tagsText: event.target.value })}
                />
              </div>
              <div className={styles.fullRow}>
                <span className={styles.previewMeta}>封面图</span>
                <div className={styles.actions}>
                  {form.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={form.coverUrl} alt="封面" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 'var(--mf-radius-sm)' }} />
                  ) : (
                    <span className={styles.previewMeta}>未选择</span>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => setMediaPicker('cover')}>
                    从素材库选择
                  </Button>
                  {form.coverUrl ? (
                    <Button variant="text" size="sm" onClick={() => setForm({ ...form, coverUrl: '' })}>
                      清除封面
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className={styles.fullRow}>
                <span className={styles.previewMeta}>图片/视频素材（{form.mediaUrls.length} 个，发布到抖音、小红书等平台必需）</span>
                <div className={styles.actions}>
                  <Button variant="secondary" size="sm" icon={<PlusIcon width={15} height={15} />} onClick={() => setMediaPicker('media')}>
                    选择素材
                  </Button>
                </div>
                {form.mediaUrls.length > 0 ? (
                  <div className={styles.variantList}>
                    {form.mediaUrls.map((url) => (
                      <div key={url} className={styles.variantItem}>
                        {/\.(png|jpe?g|webp|gif)$/i.test(url) ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={url} alt="素材" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 'var(--mf-radius-sm)', marginRight: 'var(--mf-space-2)' }} />
                        ) : null}
                        <span className={styles.variantBody} style={{ flex: 1, wordBreak: 'break-all' }}>
                          {url}
                        </span>
                        <Button variant="text" size="sm" onClick={() => setForm({ ...form, mediaUrls: form.mediaUrls.filter((item) => item !== url) })}>
                          移除
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <Select
                label="状态"
                name="status"
                options={STATUS_OPTIONS}
                value={form.status}
                onChange={(event) => setForm({ ...form, status: event.target.value as ContentStatus })}
              />
              <Select
                label="内容来源标识"
                name="aiFlagType"
                options={AI_FLAG_OPTIONS}
                value={form.aiFlagType}
                onChange={(event) => setForm({ ...form, aiFlagType: event.target.value as AiFlagType })}
              />
              {content.data?.aiGenerated ? (
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <Tag tone={content.data.aiFlagChecked ? 'success' : 'info'}>
                    {content.data.aiFlagChecked ? 'AI 标识已复核' : 'AI 标识未复核（不拦截发布）'}
                  </Tag>
                </div>
              ) : null}
            </div>

            <div className={styles.actions} style={{ marginTop: 'var(--mf-space-5)' }}>
              <Button
                variant="primary"
                icon={<SparkleIcon width={16} height={16} />}
                onClick={() => setGenerateOpen(true)}
              >
                AI 一键生成
              </Button>
              <Button loading={save.isPending} onClick={() => save.mutate()} disabled={!form.title.trim() || !form.body.trim()}>
                保存内容
              </Button>
              <Button variant="secondary" icon={<SparkleIcon width={16} height={16} />} loading={optimize.isPending} onClick={() => optimize.mutate()} disabled={!form.title.trim()}>
                AI 优化标题
              </Button>
              <Button variant="secondary" icon={<CheckIcon width={16} height={16} />} loading={checkCompliance.isPending} onClick={() => checkCompliance.mutate()} disabled={!form.body.trim()}>
                合规检查
              </Button>
              <Button variant="secondary" icon={<SparkleIcon width={16} height={16} />} onClick={() => setAdaptOpen(true)} disabled={!contentId}>
                AI 多平台适配
              </Button>
              <Button variant="secondary" icon={<PlusIcon width={16} height={16} />} onClick={() => setPublishOpen(true)} disabled={!contentId}>
                创建发布任务
              </Button>
              <Button
                variant="secondary"
                icon={<CheckIcon width={16} height={16} />}
                loading={submitReview.isPending}
                disabled={!contentId || content.data?.status === 'reviewing'}
                onClick={() => submitReview.mutate()}
              >
                {content.data?.status === 'reviewing' ? '审核中…' : '提交审核'}
              </Button>
              {content.data?.aiGenerated && !content.data.aiFlagChecked ? (
                <Button variant="text" loading={flagCheck.isPending} onClick={() => flagCheck.mutate()}>
                  标记 AI 标识已复核
                </Button>
              ) : null}
              {contentId ? (
                <Button variant="text" icon={<TrashIcon width={16} height={16} />} onClick={() => setDeleteOpen(true)}>
                  删除
                </Button>
              ) : null}
            </div>

            {!contentId ? (
              <Banner tone="info">
                <span>新建模式下 AI 适配与发布按钮会在保存后可用。</span>
              </Banner>
            ) : null}
          </Card>

          {genUsed !== null ? (
            <Card
              title="本次生成引用的品牌资料"
              extra={
                <Button variant="text" size="sm" onClick={() => setGenUsed(null)}>
                  收起
                </Button>
              }
            >
              {genUsed.length > 0 ? (
                <div className={styles.variantList}>
                  {genUsed.map((match) => (
                    <div key={match.id} className={styles.variantItem}>
                      <div style={{ display: 'flex', gap: 'var(--mf-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                        <Tag tone="brand">{match.brand}</Tag>
                        <span className={styles.variantTitle}>{match.title}</span>
                      </div>
                      <span className={styles.variantBody}>{match.matchedBy.join('；')}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <Banner tone="warning">
                  <span>
                    没有匹配到品牌资料，AI 是凭主题自由发挥的。建议到「知识库管理」补充该主题的资料后再生成，内容会更贴合品牌口径。
                  </span>
                </Banner>
              )}
            </Card>
          ) : null}

          {titleSuggestions.length > 0 ? (
            <Card
              title="AI 标题建议"
              extra={
                <Button variant="text" size="sm" onClick={() => setTitleSuggestions([])}>
                  清空
                </Button>
              }
            >
              <div className={styles.variantList}>
                {titleSuggestions.map((title) => (
                  <div className={styles.titleOption} key={title}>
                    <span>{title}</span>
                    <Button size="sm" variant="secondary" onClick={() => setForm({ ...form, title })}>
                      使用
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {compliance ? (
            <Card
              title="合规检查结果"
              extra={
                <Tag tone={compliance.passed ? 'success' : 'danger'}>
                  {compliance.passed ? '通过' : '存在风险'} · {compliance.score} 分
                </Tag>
              }
            >
              {compliance.violations.length === 0 ? (
                <Banner tone="success">未发现违规表述。</Banner>
              ) : (
                <div className={styles.violationList}>
                  {compliance.violations.map((violation) => (
                    <div className={styles.violation} key={`${violation.category}-${violation.term}`}>
                      <strong>
                        {violation.term}（{violation.category}）
                      </strong>
                      <span>{violation.reason}</span>
                      <span>建议：{violation.suggestion}</span>
                    </div>
                  ))}
                </div>
              )}
              {compliance.aiReview ? (
                <p style={{ marginTop: 'var(--mf-space-3)', fontSize: 'var(--mf-font-size-sm)', color: 'var(--mf-color-text-secondary)' }}>
                  AI 复核：{compliance.aiReview}
                </p>
              ) : null}
            </Card>
          ) : null}
        </div>

        {mode === 'edit' && contentId ? (
          <div className={styles.panel}>
            <Card title="版本历史" extra={<span className={styles.counter}>{(revisions.data ?? []).length} 个版本</span>}>
              <span className={styles.previewMeta}>
                每次保存前会自动留一份上一版（保留条数在「设置 → 素材库/内容」里配置），改错可以回滚；回滚前也会先留档当前状态。
              </span>
              {revisions.isLoading ? (
                <span className={styles.previewMeta}>加载中…</span>
              ) : (revisions.data ?? []).length === 0 ? (
                <span className={styles.previewMeta}>还没有历史版本：修改并保存后就会出现。</span>
              ) : (
                <div className={styles.variantList} style={{ marginTop: 'var(--mf-space-3)' }}>
                  {(revisions.data ?? []).map((revision) => (
                    <div key={revision.id} className={styles.variantItem}>
                      <div className={styles.variantTitle}>
                        第 {revision.version} 版 · {formatDateTime(revision.createdAt)}
                        {revision.createdByName ? ` · ${revision.createdByName}` : ''}
                      </div>
                      <div className={styles.variantBody}>{revision.body.slice(0, 120).replace(/\n/g, ' ')}</div>
                      <div className={styles.actions}>
                        <Button
                          variant="text"
                          size="sm"
                          loading={restore.isPending && restore.variables === revision.id}
                          onClick={() => {
                            if (window.confirm(`确定回滚到第 ${revision.version} 版吗？当前内容会先自动留档一份。`)) {
                              restore.mutate(revision.id);
                            }
                          }}
                        >
                          回滚到此版本
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        ) : null}

        <div className={styles.panel}>
          <Card title="平台预览" extra={<span className={styles.counter}>{PLATFORM_LABELS[previewPlatform]}</span>}>
            <div className={styles.previewTabs}>
              {PREVIEW_PLATFORMS.map((platform) => (
                <button
                  key={platform}
                  type="button"
                  className={`${styles.previewTab} ${previewPlatform === platform ? styles.previewTabActive : ''}`}
                  onClick={() => setPreviewPlatform(platform)}
                >
                  {PLATFORM_LABELS[platform]}
                </button>
              ))}
            </div>
            <div className={styles.previewCard} style={{ marginTop: 'var(--mf-space-4)' }}>
              <h3 className={styles.previewTitle}>{form.title || '（未填写标题）'}</h3>
              {form.summary ? <span className={styles.counter}>{form.summary}</span> : null}
              <div className={styles.previewBody}>
                {form.body ? form.body.slice(0, 400) : '（正文预览）'}
                {form.body.length > 400 ? '…' : ''}
              </div>
              <div className={styles.previewMeta}>
                {payload.tags.map((tag) => (
                  <Tag key={tag}>#{tag}</Tag>
                ))}
                <span className={form.aiFlagType !== AiFlagType.None ? styles.counterOver : styles.counter}>
                  {bodyLength}/{limit} 字
                </span>
                {form.aiFlagType !== AiFlagType.None ? <Tag tone="brand">含 AI 标识</Tag> : null}
              </div>
            </div>
          </Card>

          {reviews.data && reviews.data.length > 0 ? (
            <Card
              title="审核记录"
              extra={<Tag tone={content.data?.status === 'approved' ? 'success' : content.data?.status === 'rejected' ? 'danger' : 'warning'}>
                {content.data?.status === 'approved' ? '已通过' : content.data?.status === 'rejected' ? '已驳回' : '进行中'}
              </Tag>}
            >
              {reviews.data.slice(0, 3).map((review) => (
                <div key={review.id} className={styles.historyItem}>
                  <div style={{ display: 'flex', gap: 'var(--mf-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Tag tone={review.status === 'approved' ? 'success' : review.status === 'rejected' ? 'danger' : 'info'}>
                      第 {review.round} 轮 · {review.status === 'approved' ? '通过' : review.status === 'rejected' ? '驳回' : review.status === 'changes_requested' ? '要求修改' : '待审核'}
                    </Tag>
                    <span className={styles.counter}>
                      {review.submittedByName ? `提交：${review.submittedByName}` : ''}
                      {review.reviewerName ? ` · 审核：${review.reviewerName}` : ''}
                    </span>
                  </div>
                  {review.comments ? <span className={styles.variantBody}>{review.comments}</span> : null}
                </div>
              ))}
            </Card>
          ) : null}

          <Card
            title="平台版本"
            extra={
              variants.data?.length ? <Tag tone="info">{variants.data.length} 个</Tag> : null
            }
          >
            {!contentId ? (
              <EmptyState title="保存后可生成版本" description="先保存内容，再让 AI 生成各平台版本。" icon={<SparkleIcon width={22} height={22} />} />
            ) : variants.isLoading ? (
              <SkeletonRows rows={3} />
            ) : variants.data && variants.data.length > 0 ? (
              <div className={styles.variantList}>
                {variants.data.map((variant) => (
                  <div className={styles.variantItem} key={variant.id}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--mf-space-2)' }}>
                      <Tag tone="info">{PLATFORM_LABELS[variant.platform as PlatformCode]}</Tag>
                      <span className={styles.variantTitle}>{variant.title}</span>
                    </div>
                    <span className={styles.variantBody}>{variant.body.slice(0, 60)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="还没有平台版本"
                description="点击「AI 多平台适配」选择平台，系统会调用 AI 生成对应版本并自动带上 AI 标识。"
                icon={<SparkleIcon width={22} height={22} />}
              />
            )}
          </Card>
        </div>
      </div>

      <Dialog
        open={generateOpen}
        title="AI 一键生成内容"
        onClose={() => setGenerateOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setGenerateOpen(false)}>
              取消
            </Button>
            <Button
              loading={generate.isPending}
              disabled={genTopic.trim().length < 4}
              onClick={() => generate.mutate()}
              icon={<SparkleIcon width={16} height={16} />}
            >
              开始生成
            </Button>
          </>
        }
      >
        <Textarea
          label="主题（必填）"
          name="topic"
          required
          value={genTopic}
          placeholder="例如：秋季肠道健康科普，面向 30-50 岁关注肠道健康的人群，讲清膳食纤维的作用与日常补充方式"
          onChange={(event) => setGenTopic(event.target.value)}
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--mf-space-3)' }}>
          <Select
            label="目标平台（可选）"
            name="genPlatform"
            options={[{ value: '', label: '通用（不限平台）' }, ...Object.values(PlatformCode).map((platform) => ({ value: platform, label: PLATFORM_LABELS[platform] }))]}
            value={genPlatform}
            onChange={(event) => setGenPlatform(event.target.value as PlatformCode | '')}
          />
          <Input
            label="品牌（可选）"
            name="genBrand"
            placeholder="例如：卿尔美"
            value={genBrand}
            onChange={(event) => setGenBrand(event.target.value)}
          />
        </div>
        <Input
          label="语气要求（可选）"
          name="genTone"
          placeholder="例如：通俗易懂、专业克制"
          value={genTone}
          onChange={(event) => setGenTone(event.target.value)}
        />
        <Input
          label="必须覆盖的关键词（可选）"
          name="genKeywords"
          placeholder="用顿号或逗号分隔，例如：膳食纤维、肠道菌群"
          value={genKeywords}
          onChange={(event) => setGenKeywords(event.target.value)}
        />
        <Banner tone="info">
          <span>
            系统会先按主题检索品牌资料，让 AI 照着品牌口径写（不编造成分与功效）；生成结果只填入编辑器，<strong>需您核对事实后手动保存</strong>。
          </span>
        </Banner>
      </Dialog>

      <Dialog
        open={adaptOpen}
        title="AI 多平台适配"
        onClose={() => setAdaptOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdaptOpen(false)}>
              取消
            </Button>
            <Button
              loading={adapt.isPending}
              disabled={adaptPlatforms.length === 0}
              onClick={() => adapt.mutate()}
              icon={<SparkleIcon width={16} height={16} />}
            >
              开始生成
            </Button>
          </>
        }
      >
        <div className={styles.checkboxGrid}>
          {Object.values(PlatformCode).map((platform) => {
            const active = adaptPlatforms.includes(platform);
            return (
              <label
                key={platform}
                className={`${styles.checkboxItem} ${active ? styles.checkboxItemActive : ''}`}
              >
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() =>
                    setAdaptPlatforms(
                      active ? adaptPlatforms.filter((item) => item !== platform) : [...adaptPlatforms, platform],
                    )
                  }
                />
                {PLATFORM_LABELS[platform]}
              </label>
            );
          })}
        </div>
        <Input
          label="语气要求（可选）"
          name="tone"
          placeholder="例如：通俗易懂、专业克制"
          value={adaptTone}
          onChange={(event) => setAdaptTone(event.target.value)}
        />
        <label className={styles.checkboxItem} style={{ border: 'none', paddingLeft: 0 }}>
          <input type="checkbox" checked={adaptOverwrite} onChange={() => setAdaptOverwrite(!adaptOverwrite)} />
          覆盖已存在的同平台版本
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mf-space-2)' }}>
          <strong style={{ fontSize: 'var(--mf-font-size-sm)' }}>
            本次将引用 {knowledgePreview.data?.matches.length ?? 0} 条品牌资料
          </strong>
          {knowledgePreview.isLoading ? (
            <SkeletonRows rows={2} />
          ) : knowledgePreview.data && knowledgePreview.data.matches.length > 0 ? (
            knowledgePreview.data.matches.map((match) => (
              <div key={match.id} className={styles.variantItem}>
                <div style={{ display: 'flex', gap: 'var(--mf-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Tag tone="brand">{match.brand}</Tag>
                  <span className={styles.variantTitle}>{match.title}</span>
                </div>
                <span className={styles.variantBody}>{match.matchedBy.join('；')}</span>
              </div>
            ))
          ) : (
            <Banner tone="warning">
              <span>
                没有匹配到品牌资料。可到「知识库管理」补充该主题的标签/关键词，或提高资料优先级，AI 就会照着品牌口径写。
              </span>
            </Banner>
          )}
        </div>
        <Banner tone="info">
          <span>
            AI 生成的内容会记录到 AI 调用日志。是否需要标注「AI 辅助生成」由您决定：
            编辑器里的「内容来源标识」默认是「人工撰写」，按实际情况选择即可，系统不会自动改、也不会因此拦截发布。
          </span>
        </Banner>
      </Dialog>

      <Dialog
        open={publishOpen}
        title="创建发布任务"
        onClose={() => setPublishOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPublishOpen(false)}>
              取消
            </Button>
            <Button loading={publish.isPending} disabled={publishPlatforms.length === 0} onClick={() => publish.mutate()}>
              创建任务
            </Button>
          </>
        }
      >
        <div className={styles.checkboxGrid}>
          {Object.values(PlatformCode).map((platform) => {
            const active = publishPlatforms.includes(platform);
            return (
              <label key={platform} className={`${styles.checkboxItem} ${active ? styles.checkboxItemActive : ''}`}>
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() =>
                    setPublishPlatforms(
                      active ? publishPlatforms.filter((item) => item !== platform) : [...publishPlatforms, platform],
                    )
                  }
                />
                {PLATFORM_LABELS[platform]}
              </label>
            );
          })}
        </div>
        <Input
          label="排期时间（可选）"
          name="scheduledAt"
          type="datetime-local"
          value={publishScheduledAt}
          hint="留空=立即进入发布队列；选择未来时间=进入排队日历"
          onChange={(event) => setPublishScheduledAt(event.target.value)}
        />
        <Banner tone="warning">
          <WarningIcon width={16} height={16} />
          <span>公众号不允许 API 自动发布，任务会变成「待人工发布」；抖音/小红书需要先绑定账号；视频号等平台需插件填充后人工确认。</span>
        </Banner>
      </Dialog>

      <Dialog
        open={deleteOpen}
        title="删除内容"
        onClose={() => setDeleteOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              确认删除
            </Button>
          </>
        }
      >
        <span>删除为软删除：列表与接口立即不可见，数据行仍保留在数据库中。</span>
      </Dialog>
      <MediaPicker
        open={mediaPicker !== null}
        multiple={mediaPicker === 'media'}
        value={mediaPicker === 'cover' ? (form.coverUrl ? [form.coverUrl] : []) : form.mediaUrls}
        onClose={() => setMediaPicker(null)}
        onChange={(urls) => {
          if (mediaPicker === 'cover') setForm((prev) => ({ ...prev, coverUrl: urls[0] ?? '' }));
          else setForm((prev) => ({ ...prev, mediaUrls: urls }));
        }}
      />
      </>
  );
}

export default function ContentEditPage() {
  return <ContentEditor mode="edit" />;
}
