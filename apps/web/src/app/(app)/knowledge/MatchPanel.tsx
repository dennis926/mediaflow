'use client';

import { useMutation } from '@tanstack/react-query';
import { PLATFORM_LABELS } from '@mediaflow/shared';
import { useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Input, Select, Textarea } from '../../../components/ui/Field';
import { Tag } from '../../../components/ui/Tag';
import { ApiError } from '../../../lib/api/client';
import { knowledgeApi } from '../../../lib/api/endpoints';
import { useKnowledgeCategories } from '../../../lib/knowledge';
import type { KnowledgeMatchItem } from '../../../lib/api/types';
import { SearchIcon } from '../../../lib/icons';
import styles from './page.module.css';

/** 检索测试台：喂一段内容，看知识库实际会引用哪几条、为什么命中。 */
export function MatchPanel() {
  const [form, setForm] = useState({ title: '', body: '', tags: '', platform: '', limit: 5 });
  const [matches, setMatches] = useState<KnowledgeMatchItem[] | null>(null);
  const [error, setError] = useState('');
  const { label: categoryLabel } = useKnowledgeCategories();

  const run = useMutation({
    mutationFn: () =>
      knowledgeApi.match({
        title: form.title || undefined,
        body: form.body || undefined,
        tags: form.tags ? form.tags.split(/[,，\s]+/).filter(Boolean) : undefined,
        platform: form.platform || undefined,
        limit: Number(form.limit) || 5,
      }),
    onSuccess: (result) => {
      setMatches(result.matches);
      setError('');
    },
    onError: (caught: unknown) => setError(caught instanceof ApiError ? caught.message : '测试失败'),
  });

  return (
    <>
      <Banner tone="info">
        <span>
          这里模拟一次「AI 生成多平台版本」时的检索：系统按标题、正文、标签与资料里的<strong>标签 + 关键词</strong>做子串匹配，
          再加上优先级与历史引用次数排序，取前若干条拼进提示词。<strong>停用的资料不会出现</strong>——可以用它验证「某条资料到底会不会被用上」。
        </span>
      </Banner>

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Card>
        <div className={styles.form}>
          <Input label="标题（模拟要写的文章标题）" name="matchTitle" placeholder="例如：秋季肠道健康怎么吃" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          <Textarea label="正文片段" name="matchBody" rows={4} placeholder="粘贴一段要写的正文，系统会据此匹配资料" value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} />
          <div className={styles.twoCol}>
            <Input label="标签（逗号分隔）" name="matchTags" placeholder="例如：肠道, 益生元" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} />
            <Select
              label="平台（可选）"
              name="matchPlatform"
              options={[
                { value: '', label: '不限平台' },
                ...Object.entries(PLATFORM_LABELS).map(([value, label]) => ({ value, label })),
              ]}
              value={form.platform}
              onChange={(event) => setForm({ ...form, platform: event.target.value })}
            />
          </div>
          <Input label="取前几条" name="matchLimit" type="number" value={String(form.limit)} onChange={(event) => setForm({ ...form, limit: Number(event.target.value) })} />
          <div className={styles.reviewToolbar}>
            <Button icon={<SearchIcon width={16} height={16} />} loading={run.isPending} onClick={() => run.mutate()}>
              测试会引用哪些资料
            </Button>
            {matches ? <span className={styles.meta}>命中 {matches.length} 条</span> : null}
          </div>
        </div>
      </Card>

      {matches !== null ? (
        <Card>
          {matches.length === 0 ? (
            <EmptyState
              title="没有被命中的资料"
              description="说明按当前内容匹配不到任何启用的资料，AI 生成时不会引用品牌口径——建议补充资料或调整标题/标签里的关键词。"
              icon={<SearchIcon width={22} height={22} />}
            />
          ) : (
            <div className={styles.form}>
              {matches.map((match) => (
                <div key={match.id} className={styles.chunkCard}>
                  <div className={styles.chunkHead}>
                    <span className={styles.titleStrong}>{match.title}</span>
                    <Tag tone="brand">{match.brand}</Tag>
                    <Tag tone="default">{categoryLabel(match.category)}</Tag>
                    <Tag tone="success">得分 {match.score}</Tag>
                  </div>
                  <div className={styles.tags}>
                    {match.matchedBy.map((reason) => (
                      <Tag key={reason} tone="info">
                        {reason}
                      </Tag>
                    ))}
                  </div>
                  <span className={styles.preview}>{match.content.slice(0, 200)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : null}
    </>
  );
}

