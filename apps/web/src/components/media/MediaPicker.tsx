'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input, Select } from '../ui/Field';
import { Tag } from '../ui/Tag';
import { ApiError } from '../../lib/api/client';
import { mediaApi } from '../../lib/api/endpoints';
import type { MediaAssetItem } from '../../lib/api/types';
import styles from '../../app/(app)/media/page.module.css';

export interface MediaPickerProps {
  open: boolean;
  onClose: () => void;
  /** 已选中的素材外链（多个） */
  value: string[];
  /** multiple=false 时选中即替换（封面用） */
  multiple?: boolean;
  onChange: (urls: string[]) => void;
}

/**
 * 素材选择器：内容编辑器里挑图/视频用。
 * 支持现场上传 + 从素材库多选；也允许直接粘贴外链（兼容已有素材）。
 */
export function MediaPicker({ open, onClose, value, multiple = true, onChange }: MediaPickerProps) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState('');
  const [draft, setDraft] = useState<string[]>(value);
  const [manualUrl, setManualUrl] = useState('');
  const [error, setError] = useState('');
  const [uploadGroup, setUploadGroup] = useState('');

  const assets = useQuery({
    queryKey: ['media', 'picker', kind],
    queryFn: () => mediaApi.list({ kind: kind || undefined, pageSize: 60 }),
    enabled: open,
  });

  const upload = useMutation({
    mutationFn: (files: File[]) => Promise.all(files.map((file) => mediaApi.upload(file, uploadGroup.trim() || undefined))),
    onSuccess: (items) => {
      setDraft((prev) => (multiple ? [...prev, ...items.map((item) => item.url)] : items.slice(-1).map((item) => item.url)));
      setError('');
      void queryClient.invalidateQueries({ queryKey: ['media'] });
    },
    onError: (caught: unknown) => setError(caught instanceof ApiError ? caught.message : '上传失败'),
  });

  const toggle = (asset: MediaAssetItem): void => {
    if (!multiple) {
      setDraft([asset.url]);
      return;
    }
    setDraft((prev) => (prev.includes(asset.url) ? prev.filter((url) => url !== asset.url) : [...prev, asset.url]));
  };

  const items = assets.data?.items ?? [];

  return (
    <Dialog
      open={open}
      title={multiple ? '选择素材（可多选）' : '选择封面素材'}
      onClose={() => {
        setDraft(value);
        onClose();
      }}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(value);
              onClose();
            }}
          >
            取消
          </Button>
          <Button
            onClick={() => {
              onChange(draft);
              onClose();
            }}
          >
            确定{draft.length > 0 ? `（已选 ${draft.length}）` : ''}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {error ? <Banner tone="danger">{error}</Banner> : null}

        <label className={styles.filePicker}>
          <input
            type="file"
            multiple={multiple}
            accept="image/*,video/*,audio/*"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length > 0) upload.mutate(files);
              event.target.value = '';
            }}
          />
          <span>{upload.isPending ? '正在上传…' : '现场上传（图片/视频/音频，可多选）'}</span>
        </label>

        <div className={styles.twoCol}>
          <Input label="上传到分组（可选）" name="pickerGroup" value={uploadGroup} onChange={(event) => setUploadGroup(event.target.value)} />
          <Select
            label="筛选类型"
            name="pickerKind"
            options={[
              { value: '', label: '全部类型' },
              { value: 'image', label: '图片' },
              { value: 'video', label: '视频' },
            ]}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          />
        </div>

        {items.length === 0 ? (
          <Banner tone="info">
            <span>素材库还是空的：先上传几个文件，或到「素材库」页面统一管理。</span>
          </Banner>
        ) : (
          <div className={styles.pickerGrid}>
            {items.map((asset) => {
              const active = draft.includes(asset.url);
              return (
                <button key={asset.id} type="button" className={`${styles.pickerCard} ${active ? styles.pickerCardActive : ''}`} onClick={() => toggle(asset)}>
                  {asset.kind === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className={styles.pickerThumb} src={asset.url} alt={asset.originalName} />
                  ) : (
                    <span className={styles.pickerThumb} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {asset.kind === 'video' ? '▶' : '♪'}
                    </span>
                  )}
                  <span className={styles.mediaName} title={asset.originalName}>
                    {asset.originalName}
                  </span>
                  <Tag tone={active ? 'success' : 'default'}>{active ? '已选' : asset.kind === 'video' ? '视频' : '图片'}</Tag>
                </button>
              );
            })}
          </div>
        )}

        <div className={styles.form}>
          <span className={styles.meta}>也可以直接粘贴外链（用于已经在别处的素材）：</span>
          <div className={styles.toolbar}>
            <Input label="素材外链" name="manualUrl" placeholder="https://..." value={manualUrl} onChange={(event) => setManualUrl(event.target.value)} />
            <Button
              variant="secondary"
              disabled={!manualUrl.trim()}
              onClick={() => {
                const url = manualUrl.trim();
                setDraft((prev) => (multiple ? [...prev, url] : [url]));
                setManualUrl('');
              }}
            >
              添加
            </Button>
          </div>
        </div>

        {draft.length > 0 ? (
          <div className={styles.form}>
            <span className={styles.meta}>已选 {draft.length} 个：</span>
            {draft.map((url) => (
              <div key={url} className={styles.selectedRow}>
                {/\.(png|jpe?g|webp|gif)$/i.test(url) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className={styles.selectedThumb} src={url} alt="已选素材" />
                ) : (
                  <span className={styles.selectedThumb} />
                )}
                <span className={styles.mediaName} title={url} style={{ flex: 1 }}>
                  {url}
                </span>
                <Button variant="text" size="sm" onClick={() => setDraft((prev) => prev.filter((item) => item !== url))}>
                  移除
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
