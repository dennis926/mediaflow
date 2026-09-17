'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AiFlagType, ContentStatus, PLATFORM_LABELS, PlatformCode } from '@mediaflow/shared';
import { Banner } from '../../../../../components/ui/Banner';
import { Button } from '../../../../../components/ui/Button';
import { Card } from '../../../../../components/ui/Card';
import { Dialog } from '../../../../../components/ui/Dialog';
import { EmptyState } from '../../../../../components/ui/EmptyState';
import { Input, Select, Textarea } from '../../../../../components/ui/Field';
import { SkeletonRows } from '../../../../../components/ui/Skeleton';
import { Tag } from '../../../../../components/ui/Tag';
import { ApiError } from '../../../../../lib/api/client';
import { aiApi, contentApi, publishApi } from '../../../../../lib/api/endpoints';
import type { ComplianceReport } from '../../../../../lib/api/types';
import { AI_FLAG_LABELS, CONTENT_STATUS_LABELS, formatDateTime } from '../../../../../lib/format';
import { CheckIcon, PlusIcon, SparkleIcon, TrashIcon, WarningIcon } from '../../../../../lib/icons';
import styles from '../../page.module.css';

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
  status: ContentStatus;
  aiFlagType: AiFlagType;
}

const EMPTY_FORM: FormState = {
  title: '',
  summary: '',
  body: '',
  tagsText: '',
  coverUrl: '',
  status: ContentStatus.Draft,
  aiFlagType: AiFlagType.None,
};

function ContentEditor({ mode }: { mode: 'new' | 'edit' }): React.JSX.Element {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const queryClient = useQueryClient();
  const contentId = mode === 'edit' ? (params?.id ?? null) : null;

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'success' | 'danger'; text: string } | null>(null);
  const [previewPlatform, setPreviewPlatform] = useState<PlatformCode>(PlatformCode.WechatMp);
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
        text: `已生成 ${result.variants.length} 个平台版本${result.skipped.length ? `，跳过 ${result.skipped.length} 个已存在平台` : ''}（模型：${result.model}）`,
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
                  placeholder="写下正文内容……AI 生成内容会自动追加合规标识"
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
              <Input
                label="封面图地址"
                name="coverUrl"
                value={form.coverUrl}
                placeholder="https://…"
                onChange={(event) => setForm({ ...form, coverUrl: event.target.value })}
              />
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
                  <Tag tone={content.data.aiFlagChecked ? 'success' : 'danger'}>
                    {content.data.aiFlagChecked ? 'AI 标识已复核' : 'AI 标识待复核（发布会拦截）'}
                  </Tag>
                </div>
              ) : null}
            </div>

            <div className={styles.actions} style={{ marginTop: 'var(--mf-space-5)' }}>
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
        <Banner tone="info">
          <span>AI 生成内容会自动追加「（本文由 AI 辅助生成）」标识，并记录到 AI 调用日志。</span>
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
    </>
  );
}

export default function ContentEditPage() {
  return <ContentEditor mode="edit" />;
}
