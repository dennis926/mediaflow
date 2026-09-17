'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { Input, Select } from '../../../components/ui/Field';
import { Tag } from '../../../components/ui/Tag';
import { ApiError } from '../../../lib/api/client';
import { knowledgeApi } from '../../../lib/api/endpoints';
import { DEFAULT_CATEGORIES, type KnowledgeTone } from '../../../lib/knowledge';
import { PlusIcon, TrashIcon } from '../../../lib/icons';
import styles from './page.module.css';

interface DraftCategory {
  code: string;
  label: string;
  tone: KnowledgeTone;
  description: string;
}

const TONE_OPTIONS: Array<{ value: KnowledgeTone; label: string }> = [
  { value: 'brand', label: '品牌色' },
  { value: 'info', label: '蓝色' },
  { value: 'success', label: '绿色' },
  { value: 'warning', label: '橙色' },
  { value: 'danger', label: '红色' },
  { value: 'default', label: '灰色' },
];

/**
 * 分类是配置项而非写死的枚举：换一家公司、换一个行业，直接在这里改分类即可上线，
 * 不需要改代码。分类的 code 是数据里的稳定标识，建好后不要改（改了要对存量数据做迁移）。
 */
export function CategoriesPanel({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DraftCategory[]>([]);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);

  const query = useQuery({ queryKey: ['knowledge', 'categories'], queryFn: () => knowledgeApi.categories(), staleTime: 0 });
  const usage = new Map((query.data?.categories ?? []).map((item) => [item.code, item.count]));

  useEffect(() => {
    if (!query.data) return;
    setDraft(
      query.data.categories.map((item) => ({
        code: item.code,
        label: item.label,
        tone: (item.tone as KnowledgeTone) ?? 'default',
        description: item.description ?? '',
      })),
    );
  }, [query.data]);

  const save = useMutation({
    mutationFn: () =>
      knowledgeApi.saveCategories(
        draft.map((item) => ({
          code: item.code.trim(),
          label: item.label.trim(),
          tone: item.tone,
          ...(item.description.trim() ? { description: item.description.trim() } : {}),
        })),
      ),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: '分类已保存，界面上的下拉与标签即刻生效' });
      void queryClient.invalidateQueries({ queryKey: ['knowledge'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '保存失败' }),
  });

  const move = (index: number, delta: number): void => {
    const next = [...draft];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setDraft(next);
  };

  const patch = (index: number, changes: Partial<DraftCategory>): void => {
    setDraft((prev) => prev.map((item, position) => (position === index ? { ...item, ...changes } : item)));
  };

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
          分类决定了资料的归类、界面标签与 AI 起草时的写作规范。这里是<strong>配置项</strong>：增删改后立即生效，不用改代码——
          换公司/换行业时按自己的业务改一遍即可。分类标识（code）是数据里的稳定字段，建好后尽量别改；正在被资料使用的分类不允许删除。
        </span>
      </Banner>

      <Card>
        <div className={styles.form}>
          {draft.map((item, index) => (
            <div key={`${item.code}-${index}`} className={styles.chunkCard}>
              <div className={styles.chunkHead}>
                <Tag tone={item.tone}>{item.label || '未命名'}</Tag>
                <span className={styles.meta}>
                  标识：{item.code}
                  {usage.get(item.code) !== undefined ? ` · 已有 ${usage.get(item.code)} 条资料` : ' · 新分类'}
                </span>
                <span className={styles.spacer}>
                  <Button variant="text" size="sm" disabled={index === 0} onClick={() => move(index, -1)}>
                    上移
                  </Button>
                  <Button variant="text" size="sm" disabled={index === draft.length - 1} onClick={() => move(index, 1)}>
                    下移
                  </Button>
                  <Button
                    variant="text"
                    size="sm"
                    disabled={(usage.get(item.code) ?? 0) > 0}
                    onClick={() => setDraft((prev) => prev.filter((_, position) => position !== index))}
                  >
                    <TrashIcon width={14} height={14} /> 删除
                  </Button>
                </span>
              </div>
              <div className={styles.twoCol}>
                <Input label="标识（英文小写，建后勿改）" name={`code-${index}`} value={item.code} disabled={usage.get(item.code) !== undefined} onChange={(event) => patch(index, { code: event.target.value })} />
                <Input label="名称（界面上显示）" name={`label-${index}`} value={item.label} onChange={(event) => patch(index, { label: event.target.value })} />
              </div>
              <div className={styles.twoCol}>
                <Select
                  label="标签配色"
                  name={`tone-${index}`}
                  options={TONE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                  value={item.tone}
                  onChange={(event) => patch(index, { tone: event.target.value as KnowledgeTone })}
                />
                <Input label="说明（AI 起草时的写作提示）" name={`desc-${index}`} value={item.description} onChange={(event) => patch(index, { description: event.target.value })} />
              </div>
            </div>
          ))}

          <div className={styles.reviewToolbar}>
            <Button
              variant="secondary"
              icon={<PlusIcon width={15} height={15} />}
              disabled={!canEdit}
              onClick={() => setDraft((prev) => [...prev, { code: '', label: '', tone: 'info', description: '' }])}
            >
              新增分类
            </Button>
            <Button variant="text" onClick={() => setDraft(DEFAULT_CATEGORIES.map((item) => ({ code: item.code, label: item.label, tone: item.tone, description: item.description ?? '' })))}>
              恢复为默认分类
            </Button>
            <Button loading={save.isPending} disabled={!canEdit || draft.length === 0} onClick={() => save.mutate()}>
              保存分类
            </Button>
            {!canEdit ? <span className={styles.meta}>当前角色只能查看分类配置（需要 owner/admin/editor 才能修改）</span> : null}
          </div>
        </div>
      </Card>
    </>
  );
}
