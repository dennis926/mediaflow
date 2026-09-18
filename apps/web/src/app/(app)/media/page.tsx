'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { Dialog } from '../../../components/ui/Dialog';
import { EmptyState } from '../../../components/ui/EmptyState';
import { QueryError } from '../../../components/ui/QueryError';
import { Input, Select } from '../../../components/ui/Field';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { ApiError } from '../../../lib/api/client';
import { mediaApi } from '../../../lib/api/endpoints';
import type { MediaAssetItem } from '../../../lib/api/types';
import { formatDateTime } from '../../../lib/format';
import { ContentIcon, PlusIcon, TrashIcon } from '../../../lib/icons';
import styles from './page.module.css';

const KIND_LABELS: Record<string, string> = { image: '图片', video: '视频', audio: '音频', file: '文件' };

function sizeText(size: string): string {
  const bytes = Number(size);
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 素材库：发布到抖音/小红书等平台必须带本地图片或视频，这里统一上传、分组与外链管理。
 * 单文件上限、允许类型、存放目录、访问前缀都在「设置 → 素材库」里配置。
 */
export default function MediaPage() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState('');
  const [group, setGroup] = useState('');
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [uploadGroup, setUploadGroup] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);
  const [preview, setPreview] = useState<MediaAssetItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MediaAssetItem | null>(null);

  const assets = useQuery({
    queryKey: ['media', { kind, group, appliedKeyword, page }],
    queryFn: () => mediaApi.list({ kind: kind || undefined, group: group || undefined, keyword: appliedKeyword || undefined, page, pageSize: 24 }),
  });
  const groups = useQuery({ queryKey: ['media', 'groups'], queryFn: () => mediaApi.groups() });

  const upload = useMutation({
    mutationFn: (files: File[]) => Promise.all(files.map((file) => mediaApi.upload(file, uploadGroup.trim() || undefined))),
    onSuccess: (items) => {
      setFeedback({ tone: 'success', text: `已上传 ${items.length} 个素材` });
      void queryClient.invalidateQueries({ queryKey: ['media'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '上传失败' }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => mediaApi.remove(id),
    onSuccess: () => {
      setPendingDelete(null);
      setFeedback({ tone: 'info', text: '素材已删除（文件同时从磁盘移除）' });
      void queryClient.invalidateQueries({ queryKey: ['media'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '删除失败' }),
  });

  const items = assets.data?.items ?? [];

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
          上传的图片/视频会在内容编辑器里直接选用，发布到抖音、小红书等平台时必须带媒体素材。文件按随机文件名保存，
          外链可直接复制给平台使用；单文件上限、允许的类型、存放目录与访问前缀都在「设置 → 素材库」调整。
        </span>
      </Banner>

      <Card>
        <div className={styles.form}>
          <label className={styles.filePicker}>
            <input
              type="file"
              multiple
              accept="image/*,video/*,audio/*"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) upload.mutate(files);
                event.target.value = '';
              }}
            />
            <span>{upload.isPending ? '正在上传…' : '点击选择文件上传（可多选，支持图片/视频/音频）'}</span>
          </label>
          <div className={styles.twoCol}>
            <Input label="素材分组（可选，便于按项目归类）" name="uploadGroup" placeholder="例如：秋季新品" value={uploadGroup} onChange={(event) => setUploadGroup(event.target.value)} />
            <Select
              label="按类型筛选"
              name="mediaKind"
              options={[
                { value: '', label: '全部类型' },
                { value: 'image', label: '图片' },
                { value: 'video', label: '视频' },
                { value: 'audio', label: '音频' },
              ]}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className={styles.toolbar}>
            <Select
              label="按分组筛选"
              name="mediaGroup"
              options={[{ value: '', label: '全部分组' }, ...(groups.data ?? []).map((item) => ({ value: item.group, label: `${item.group}（${item.count}）` }))]}
              value={group}
              onChange={(event) => {
                setGroup(event.target.value);
                setPage(1);
              }}
            />
            <Input
              label="搜索文件名"
              name="mediaKeyword"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setAppliedKeyword(keyword.trim());
                  setPage(1);
                }
              }}
            />
            <Button
              variant="secondary"
              onClick={() => {
                setAppliedKeyword(keyword.trim());
                setPage(1);
              }}
            >
              搜索
            </Button>
          </div>
        </div>
      </Card>

      <Card flush>
        {assets.isError ? (
          <QueryError error={assets.error} action="加载素材" onRetry={() => void assets.refetch()} />
        ) : assets.isLoading ? (
          <div style={{ padding: 'var(--mf-space-5)' }}>
            <SkeletonRows rows={3} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState title="还没有素材" description="上传图片或视频后，就能在内容编辑器里选用，发布到平台时也必须有媒体素材。" icon={<ContentIcon width={22} height={22} />} />
        ) : (
          <div className={styles.mediaGrid}>
            {items.map((asset) => (
              <div key={asset.id} className={styles.mediaCard}>
                <button type="button" className={styles.mediaPreview} onClick={() => setPreview(asset)}>
                  {asset.kind === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={asset.url} alt={asset.originalName} />
                  ) : (
                    <span className={styles.mediaGlyph}>{asset.kind === 'video' ? '▶' : '♪'}</span>
                  )}
                </button>
                <div className={styles.mediaMeta}>
                  <span className={styles.mediaName} title={asset.originalName}>
                    {asset.originalName}
                  </span>
                  <span className={styles.meta}>
                    <Tag tone="default">{KIND_LABELS[asset.kind] ?? asset.kind}</Tag>
                    {sizeText(asset.size)}
                    {asset.groupName ? <Tag tone="info">{asset.groupName}</Tag> : null}
                  </span>
                </div>
                <div className={styles.mediaActions}>
                  <Button
                    variant="text"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(asset.url);
                      setFeedback({ tone: 'success', text: '外链已复制到剪贴板' });
                    }}
                  >
                    复制外链
                  </Button>
                  <Button variant="text" size="sm" onClick={() => setPendingDelete(asset)}>
                    <TrashIcon width={14} height={14} /> 删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {assets.data && assets.data.meta.total > 0 ? (
          <div className={styles.mediaPager}>
            <span className={styles.meta}>
              共 {assets.data.meta.total} 个素材，当前 {page}/{assets.data.meta.totalPages} 页
            </span>
            <span className={styles.mediaActions}>
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((prev) => prev - 1)}>
                上一页
              </Button>
              <Button variant="secondary" size="sm" disabled={page >= assets.data.meta.totalPages} onClick={() => setPage((prev) => prev + 1)}>
                下一页
              </Button>
            </span>
          </div>
        ) : null}
      </Card>

      <Dialog open={Boolean(preview)} title={preview?.originalName ?? '素材预览'} onClose={() => setPreview(null)}>
        {preview ? (
          <div className={styles.form}>
            {preview.kind === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className={styles.mediaLarge} src={preview.url} alt={preview.originalName} />
            ) : preview.kind === 'video' ? (
              <video className={styles.mediaLarge} src={preview.url} controls />
            ) : (
              <audio src={preview.url} controls />
            )}
            <span className={styles.meta}>
              外链：{preview.url}
              <br />
              {KIND_LABELS[preview.kind] ?? preview.kind} · {sizeText(preview.size)} · 上传于 {formatDateTime(preview.createdAt)}
              {preview.uploadedByName ? ` · 上传者 ${preview.uploadedByName}` : ''}
            </span>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(pendingDelete)}
        title="删除素材"
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
        <span>删除后文件会从磁盘移除，已引用该素材的内容会失效。确定删除「{pendingDelete?.originalName}」吗？</span>
      </Dialog>

      {items.length > 0 ? (
        <span className={styles.meta}>
          <PlusIcon width={14} height={14} /> 提示：在内容编辑器里点「选择素材」即可从这里挑图，不用手动填外链。
        </span>
      ) : null}
    </>
  );
}
