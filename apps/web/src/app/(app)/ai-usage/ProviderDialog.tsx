'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Input, Select } from '../../../components/ui/Field';
import { ApiError } from '../../../lib/api/client';
import { aiApi } from '../../../lib/api/endpoints';
import type { ProviderPricingView } from '../../../lib/api/types';
import styles from './page.module.css';

export interface ProviderDialogProps {
  open: boolean;
  /** null = 新增；传入 = 编辑该供应商 */
  current: ProviderPricingView | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}

const CUSTOM_OPTION = { value: 'custom', label: '自定义供应商（OpenAI 兼容）' };

/**
 * 供应商配置：可存多套（DeepSeek / GPT / Claude / GLM …）。
 * 密钥只在服务端保存，界面上显示打码值；留空表示不修改。
 */
export function ProviderDialog({ open, current, onClose, onSaved, onError }: ProviderDialogProps) {
  const catalog = useQuery({ queryKey: ['ai', 'catalog'], queryFn: () => aiApi.catalog(), enabled: open });
  const [form, setForm] = useState({
    provider: 'deepseek',
    label: '',
    baseUrl: '',
    apiKey: '',
    modelsText: '',
    multiplier: 1,
    protocol: 'openai-compatible',
  });

  useEffect(() => {
    if (!open) return;
    if (current) {
      setForm({
        provider: current.provider,
        label: current.label,
        baseUrl: current.baseUrl,
        apiKey: '', // 留空表示不修改
        modelsText: (current.models ?? []).map((model) => model.model).join('\n'),
        multiplier: current.multiplier,
        protocol: current.protocol ?? 'openai-compatible',
      });
    } else {
      setForm({ provider: 'deepseek', label: '', baseUrl: '', apiKey: '', modelsText: '', multiplier: 1, protocol: 'openai-compatible' });
    }
  }, [open, current]);

  const save = useMutation({
    mutationFn: () =>
      aiApi.upsertProvider({
        provider: form.provider,
        label: form.label.trim() || undefined,
        baseUrl: form.baseUrl.trim() || undefined,
        apiKey: form.apiKey.trim() || undefined,
        models: form.modelsText
          .split(/[\n,，\s]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        multiplier: Number(form.multiplier) || 1,
        protocol: form.protocol,
      }),
    onSuccess: () => onSaved(`供应商「${form.label || form.provider}」已保存`),
    onError: (error: unknown) => onError(error instanceof ApiError ? error.message : '保存失败'),
  });

  const options = [{ value: '', label: '请选择预置供应商…' }, ...(catalog.data?.providers ?? []).map((item) => ({ value: item.provider, label: item.label })), CUSTOM_OPTION];

  const applyPreset = (provider: string): void => {
    const preset = (catalog.data?.providers ?? []).find((item) => item.provider === provider);
    const models = (catalog.data?.models ?? []).find((item) => item.provider === provider);
    setForm((prev) => ({
      ...prev,
      provider,
      label: preset?.label ?? (provider === 'custom' ? '自定义供应商' : provider),
      baseUrl: preset?.defaultBaseUrl ?? '',
      modelsText: models?.models.map((item) => item.model).join('\n') ?? prev.modelsText,
    }));
  };

  return (
    <Dialog
      open={open}
      title={current ? `编辑供应商：${current.label}` : '添加供应商'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button loading={save.isPending} disabled={!form.provider} onClick={() => save.mutate()}>
            保存
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <Banner tone="info">
          <span>
            可同时配置多个供应商：密钥加密存储、界面只显示打码值。模型列表一行一个，用于生成「按模型看用量」的标签；
            若用的是第三方中转，把「分组倍率」填成它的折扣（例如官方价的 0.8 倍就填 0.8），实付价会按倍率折算。
          </span>
        </Banner>

        <Select
          label="供应商"
          name="provider"
          options={options}
          value={form.provider}
          onChange={(event) => applyPreset(event.target.value)}
        />
        <div className={styles.twoCol}>
          <Input label="显示名" name="label" placeholder="例如：DeepSeek 官方 / 某中转 GPT" value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} />
          <Input
            label="分组倍率（实付 = 官方 × 汇率 × 倍率）"
            name="multiplier"
            type="number"
            value={String(form.multiplier)}
            onChange={(event) => setForm({ ...form, multiplier: Number(event.target.value) })}
          />
        </div>
        <Input label="接口地址（OpenAI 兼容）" name="baseUrl" placeholder="https://api.deepseek.com/v1" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
        <Input
          label={current ? 'API Key（留空表示不修改）' : 'API Key'}
          name="apiKey"
          type="password"
          autoComplete="off"
          placeholder={current?.hasApiKey ? `已配置：${current.models.length > 0 ? '' : ''}（留空保持不变）` : 'sk-...'}
          value={form.apiKey}
          onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
        />
        <label className={styles.textareaLabel}>
          <span className={styles.meta}>模型列表（一行一个，例如 deepseek-flash / gpt-5.5 / claude-sonnet-5）</span>
          <textarea
            className={styles.textarea}
            rows={5}
            value={form.modelsText}
            onChange={(event) => setForm({ ...form, modelsText: event.target.value })}
          />
        </label>
        {current?.hasApiKey ? <span className={styles.meta}>当前密钥：{current.baseUrl ? `${current.baseUrl} · ` : ''}已配置（不在界面上回显）</span> : null}
      </div>
    </Dialog>
  );
}
