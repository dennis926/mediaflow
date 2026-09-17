'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { Input, Select } from '../../../components/ui/Field';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { ApiError } from '../../../lib/api/client';
import { settingsApi } from '../../../lib/api/endpoints';
import type { AiTestResult, SettingView } from '../../../lib/api/types';
import styles from './page.module.css';

interface RowState {
  [key: string]: string;
}

function SourceTag({ item }: { item: SettingView }) {
  if (item.source === 'db') return <Tag tone="success">后台配置</Tag>;
  if (item.source === 'env') return <Tag tone="info">来自 .env</Tag>;
  return <Tag tone="warning">未配置</Tag>;
}

/** JSON 类配置的提示：告诉运营"还有更友好的界面"或者"怎么改"。 */
const JSON_HINTS: Record<string, string> = {
  COMPLIANCE_RULES: 'JSON 数组：每项含 category/terms/reason/suggestion/penalty',
  AI_PLATFORM_GUIDANCE: 'JSON 对象：平台代码 → 写作要求',
  KB_CATEGORIES: '也可在「知识库管理 → 分类设置」里可视化编辑',
};

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RowState>({});
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  /** 配置项变多后按分组切换，避免一页滚动几千像素 */
  const [activeGroup, setActiveGroup] = useState('');

  const settings = useQuery({ queryKey: ['settings'], queryFn: () => settingsApi.list() });

  useEffect(() => {
    if (!settings.data) return;
    const next: RowState = {};
    for (const group of settings.data) {
      for (const item of group.items) next[item.key] = item.value;
    }
    setDraft(next);
  }, [settings.data]);

  const dirtyItems = useMemo(() => {
    if (!settings.data) return [];
    const items: Array<{ key: string; value: string }> = [];
    for (const group of settings.data) {
      for (const item of group.items) {
        const current = draft[item.key];
        // Secret fields show a mask; only send them when the operator typed something new.
        if (current !== undefined && current !== item.value && !current.startsWith('••••')) {
          items.push({ key: item.key, value: current });
        }
      }
    }
    return items;
  }, [settings.data, draft]);

  const save = useMutation({
    mutationFn: () => settingsApi.update(dirtyItems),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: `已保存 ${dirtyItems.length} 项配置` });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['ai', 'status'] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '保存失败' }),
  });

  const testAi = useMutation({
    mutationFn: () =>
      settingsApi.testAi({
        apiKey: draft.AI_API_KEY?.startsWith('••••') ? undefined : draft.AI_API_KEY,
        model: draft.AI_MODEL,
        baseUrl: draft.AI_API_BASE,
      }),
    onSuccess: (result) => {
      setTestResult(result);
      setFeedback(
        result.ok
          ? { tone: 'success', text: `AI 连接正常（${result.provider} / ${result.model}，${result.latencyMs}ms）` }
          : { tone: 'danger', text: `AI 连接失败：${result.error ?? '未知错误'}` },
      );
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '测试失败' }),
  });

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

      <Banner tone="info">
        <span>
          这里的配置会覆盖服务器 <code>.env</code> 的值，密钥类字段加密后存入数据库（界面只显示后四位）。留空即表示「清除后台配置、回退到 .env」。
          这样把代码发布到仓库时，仓库里只需要 <code>.env.example</code> 模板，真实密钥都在后台维护。
        </span>
      </Banner>

      {settings.isLoading ? (
        <Card title="系统设置">
          <SkeletonRows rows={6} />
        </Card>
      ) : (
        <>
          <div className={styles.tabs}>
            {(settings.data ?? []).map((group) => (
              <button
                key={group.group}
                type="button"
                className={`${styles.tab} ${(activeGroup || settings.data?.[0]?.group) === group.group ? styles.tabActive : ''}`}
                onClick={() => setActiveGroup(group.group)}
              >
                {group.label}
                {dirtyItems.some((item) => group.items.some((entry) => entry.key === item.key)) ? ' •' : ''}
              </button>
            ))}
          </div>
          {(settings.data ?? [])
            .filter((group) => group.group === (activeGroup || settings.data?.[0]?.group))
            .map((group) => (
          <Card
            key={group.group}
            title={group.label}
            extra={
              group.group === 'ai' ? (
                <Button size="sm" variant="secondary" loading={testAi.isPending} onClick={() => testAi.mutate()}>
                  测试连接
                </Button>
              ) : null
            }
          >
            <div className={styles.group}>
              {group.items.map((item) => (
                <div className={styles.item} key={item.key}>
                  <div className={styles.meta}>
                    <span className={styles.label}>{item.label}</span>
                    <span className={styles.desc}>{item.description}</span>
                    <span style={{ marginTop: 'var(--mf-space-1)' }}>
                      <SourceTag item={item} />
                    </span>
                  </div>
                  <div className={styles.controlRow}>
                    {item.options ? (
                      <Select
                        name={item.key}
                        options={item.options}
                        value={draft[item.key] ?? ''}
                        onChange={(event) => setDraft({ ...draft, [item.key]: event.target.value })}
                      />
                    ) : (
                      <Input
                        name={item.key}
                        type={item.secret ? 'password' : 'text'}
                        autoComplete="off"
                        placeholder={item.placeholder ?? (item.configured ? '' : '未配置')}
                        value={draft[item.key] ?? ''}
                        onChange={(event) => setDraft({ ...draft, [item.key]: event.target.value })}
                      />
                    )}
                    {JSON_HINTS[item.key] ? <Tag tone="info">{JSON_HINTS[item.key]}</Tag> : null}
                  </div>
                </div>
              ))}
            </div>
          </Card>
            ))}
        </>
      )}

      {testResult?.ok ? (
        <Banner tone="success">
          模型回复：{testResult.reply ?? '（无内容）'}
        </Banner>
      ) : null}

      <Card>
        <div className={styles.footer}>
          <Button loading={save.isPending} disabled={dirtyItems.length === 0} onClick={() => save.mutate()}>
            保存{ dirtyItems.length > 0 ? `（${dirtyItems.length} 项）` : '' }
          </Button>
          <Button variant="secondary" disabled={dirtyItems.length === 0} onClick={() => {
            const next: RowState = {};
            for (const group of settings.data ?? []) for (const item of group.items) next[item.key] = item.value;
            setDraft(next);
          }}>
            放弃修改
          </Button>
          <span className={styles.desc}>保存后会写入审计日志（只记录改了哪些项，不记录密钥内容）。</span>
        </div>
      </Card>
    </>
  );
}
