'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError } from '../../lib/api/client';
import { contentApi, publishApi } from '../../lib/api/endpoints';
import type { PublishTask } from '../../lib/api/types';
import { PLATFORM_LABELS, PlatformCode } from '@mediaflow/shared';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Field';
import styles from './manual-publish.module.css';

export interface ManualPublishDialogProps {
  open: boolean;
  task: PublishTask | null;
  onClose: () => void;
}

/** 复制到剪贴板：优先 Clipboard API，失败回退到临时 textarea（http 页面/旧内核也能用）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走回退方案
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 人工发布回填对话框（无平台密钥时的主路径）。
 *
 * 左边给"可直接粘贴到平台后台"的成品文本（含标题、正文、话题标签；AI 生成内容的显式标识已在正文里），
 * 右边回填结果：填链接 = 已发布，写原因 = 发布失败。两条路都会写审计，任务状态不再卡在"待人工发布"。
 */
export function ManualPublishDialog({ open, task, onClose }: ManualPublishDialogProps) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setUrl('');
      setNote('');
      setReason('');
      setFeedback(null);
      setCopied(false);
    }
  }, [open]);

  const content = useQuery({
    queryKey: ['content', task?.contentId, 'detail'],
    queryFn: () => contentApi.get(task!.contentId),
    enabled: Boolean(open && task?.contentId),
  });
  const variants = useQuery({
    queryKey: ['content', task?.contentId, 'variants'],
    queryFn: () => contentApi.variants(task!.contentId),
    enabled: Boolean(open && task?.contentId),
  });

  const variant = (variants.data ?? []).find((item) => item.platform === task?.platform) ?? null;
  const title = variant?.title ?? content.data?.title ?? '';
  const body = variant?.body ?? content.data?.body ?? '';
  const tags = content.data?.tags ?? [];
  /** 直接粘到平台后台的成品文本：标题 + 正文 + 话题标签 */
  const copyPayload = [title, '', body, tags.length > 0 ? tags.map((tag) => `#${tag}`).join(' ') : '']
    .filter((part) => part !== undefined)
    .join('\n')
    .trim();

  const publish = useMutation({
    mutationFn: () =>
      publishApi.markManualPublished(task!.id, {
        url: url.trim() || undefined,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: '已回填为「已发布」，数据与审计都已记录' });
      void queryClient.invalidateQueries({ queryKey: ['publish'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '回填失败' }),
  });

  const fail = useMutation({
    mutationFn: () => publishApi.markManualFailed(task!.id, { reason: reason.trim() }),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: '已标记为「发布失败」，可在队列里重试或重排' });
      void queryClient.invalidateQueries({ queryKey: ['publish'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '操作失败' }),
  });

  if (!task) return null;

  return (
    <Dialog
      open={open}
      title={`人工发布回填：${PLATFORM_LABELS[task.platform as PlatformCode] ?? task.platform}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
          <Button
            variant="secondary"
            loading={fail.isPending}
            disabled={reason.trim().length < 2}
            onClick={() => fail.mutate()}
          >
            标记发布失败
          </Button>
          <Button loading={publish.isPending} onClick={() => publish.mutate()}>
            标记已发布
          </Button>
        </>
      }
    >
      <p className={styles.hint}>
        公众号按平台规则禁止 API 自动发布；视频号/知乎/头条/百家号等由浏览器插件填充内容后人工确认。
        请先在平台后台发布，再回到这里回填结果——任务就不会停在「待人工发布」。
      </p>

      {feedback ? <Banner tone={feedback.tone}>{feedback.text}</Banner> : null}

      <div className={styles.columns}>
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <strong>待发布内容</strong>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                const ok = await copyText(copyPayload);
                setCopied(ok);
                if (!ok) setFeedback({ tone: 'danger', text: '复制失败：请手动选中文本后复制' });
              }}
            >
              {copied ? '已复制 ✓' : '复制正文'}
            </Button>
          </div>
          <div className={styles.preview} data-testid="manual-copy-preview">
            <div className={styles.previewTitle}>{title || '（标题为空）'}</div>
            <pre className={styles.previewBody}>{body || '（正文为空）'}</pre>
            {tags.length > 0 ? <div className={styles.previewTags}>{tags.map((tag) => `#${tag}`).join(' ')}</div> : null}
          </div>
          {content.isError ? <Banner tone="danger">内容加载失败，请刷新后重试</Banner> : null}
        </section>

        <section className={styles.panel}>
          <strong>回填结果</strong>
          <Input
            label="发布后的链接（可选）"
            name="manualUrl"
            placeholder="https://mp.weixin.qq.com/s/..."
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <Input
            label="备注（可选）"
            name="manualNote"
            placeholder="例如：未群发，仅发布到草稿箱"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <Input
            label="失败原因（标记失败时必填）"
            name="manualReason"
            placeholder="例如：平台提示图片尺寸不合规"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </section>
      </div>
    </Dialog>
  );
}
