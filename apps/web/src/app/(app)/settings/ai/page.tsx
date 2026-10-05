'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Banner } from '../../../../components/ui/Banner';
import { Button } from '../../../../components/ui/Button';
import { Card } from '../../../../components/ui/Card';
import { Input, Select } from '../../../../components/ui/Field';
import { SkeletonRows } from '../../../../components/ui/Skeleton';
import { Tag } from '../../../../components/ui/Tag';
import { ApiError } from '../../../../lib/api/client';
import { aiConfigApi } from '../../../../lib/api/endpoints';
import type { AiConfigView } from '../../../../lib/api/types';
import styles from '../page.module.css';

type Step = 'idle' | 'tested' | 'fetched';

/**
 * AI 配置（独立模块）。
 *
 * 三步闭环，每一步都看得见结果：
 *   ① 测试连接 —— 用当前凭据真实发一次请求，把延迟和模型回复显示出来；
 *   ② 获取模型 —— 连上之后直接列出该 Key 能用的模型，不让用户凭记忆手打标识；
 *   ③ 选默认 —— 从列表里挑一个作为全站默认，保存后立即生效（不需要重启）。
 */
export default function AiConfigPage() {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ['ai-config'], queryFn: () => aiConfigApi.view() });

  const [provider, setProvider] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [step, setStep] = useState<Step>('idle');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info' | 'warning'; text: string } | null>(null);

  useEffect(() => {
    if (!config.data) return;
    setProvider(config.data.provider);
    setBaseUrl(config.data.baseUrl);
    setModel(config.data.model);
    setApiKey(config.data.apiKeyMasked);
    setModels(config.data.model ? [config.data.model] : []);
    setStep('idle');
  }, [config.data]);

  const catalog = useMemo(() => config.data?.catalog ?? [], [config.data]);
  const currentCatalog = catalog.find((item) => item.provider === provider);

  /** 表单里是否填了"新"密钥（打码值代表沿用已保存的）。 */
  const typedKey = apiKey && !apiKey.includes('***') ? apiKey : undefined;
  const payload = { provider, apiKey: typedKey, baseUrl: baseUrl || undefined, model: model || undefined };

  const test = useMutation({
    mutationFn: () => aiConfigApi.test(payload),
    onSuccess: (result) => {
      setStep('tested');
      setFeedback(
        result.ok
          ? {
              tone: 'success',
              text: `连接成功：${result.provider} / ${result.model}，耗时 ${result.latencyMs}ms${result.reply ? `，模型回复「${result.reply}」` : ''}`,
            }
          : { tone: 'danger', text: `连接失败：${result.error ?? '未知错误'}` },
      );
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '测试请求失败' }),
  });

  const fetchModels = useMutation({
    mutationFn: () => aiConfigApi.models(payload),
    onSuccess: (result) => {
      if (!result.ok) {
        setFeedback({ tone: 'danger', text: result.error ?? '获取模型失败' });
        return;
      }
      setModels(result.models);
      setStep('fetched');
      // 当前模型不在列表里就自动选第一个，省掉一次点击
      if (!result.models.includes(model)) setModel(result.models[0] ?? '');
      setFeedback({ tone: 'success', text: `获取到 ${result.models.length} 个可用模型，请选择默认使用的模型` });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '获取模型失败' }),
  });

  const save = useMutation({
    mutationFn: () => aiConfigApi.saveDefault({ provider, model, baseUrl: baseUrl || undefined, apiKey: typedKey, models }),
    onSuccess: (view: AiConfigView) => {
      setFeedback({ tone: 'success', text: `已保存并生效：${view.provider} / ${view.model}` });
      setApiKey(view.apiKeyMasked);
      void queryClient.invalidateQueries({ queryKey: ['ai-config'] });
      void queryClient.invalidateQueries({ queryKey: ['ai', 'status'] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '保存失败' }),
  });

  const offline = useMutation({
    mutationFn: () => aiConfigApi.offline(),
    onSuccess: () => {
      setFeedback({ tone: 'info', text: '已切换为离线占位，不会调用任何外部接口，也不消耗额度' });
      void queryClient.invalidateQueries({ queryKey: ['ai-config'] });
      void queryClient.invalidateQueries({ queryKey: ['ai', 'status'] });
    },
  });

  const dirty =
    Boolean(config.data) &&
    (provider !== config.data?.provider ||
      model !== config.data?.model ||
      baseUrl !== config.data?.baseUrl ||
      Boolean(typedKey));

  return (
    <>
      {feedback ? (
        <Banner tone={feedback.tone}>
          {feedback.text}
          <button type="button" onClick={() => setFeedback(null)} className={styles.bannerClose}>
            知道了
          </button>
        </Banner>
      ) : null}

      {config.isLoading ? (
        <Card title="AI 配置">
          <SkeletonRows rows={5} />
        </Card>
      ) : (
        <>
          <Card
            title="当前生效的 AI"
            extra={
              config.data?.offline ? <Tag tone="warning">离线占位</Tag> : <Tag tone="success">真实调用</Tag>
            }
          >
            <div className={styles.summaryGrid}>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>供应商</span>
                <span className={styles.summaryValue}>{currentCatalog?.label ?? provider ?? '—'}</span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>默认模型</span>
                <span className={styles.summaryValue}>{config.data?.model || '未设置'}</span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>接口地址</span>
                <span className={styles.summaryValue}>{config.data?.baseUrl || '（供应商默认地址）'}</span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>密钥</span>
                <span className={styles.summaryValue}>
                  {config.data?.hasApiKey ? config.data.apiKeyMasked : '未配置'}
                </span>
              </div>
            </div>
            <Banner tone="info">
              <span>
                内容一键生成、多平台适配、合规检查、知识库起草都用这里的配置。切换到别的供应商只需重新测试并保存，
                保存后立即生效，不需要重启服务。
              </span>
            </Banner>
          </Card>

          <Card title="配置供应商">
            <div className={styles.steps}>
              <span className={`${styles.stepChip} ${styles.stepChipDone}`}>1 填写凭据</span>
              <span className={`${styles.stepChip} ${step !== 'idle' ? styles.stepChipDone : ''}`}>2 测试连接</span>
              <span className={`${styles.stepChip} ${step === 'fetched' ? styles.stepChipDone : ''}`}>3 获取并选择模型</span>
              <span className={`${styles.stepChip} ${dirty ? '' : styles.stepChipDone}`}>4 保存生效</span>
            </div>

            <div className={styles.formGrid}>
              <Select
                label="供应商"
                name="provider"
                value={provider}
                options={[
                  { value: 'mock', label: '离线占位（不调用外部接口）' },
                  ...catalog.map((item) => ({
                    value: item.provider,
                    label: item.regionNotice ? `${item.label}（本服务器所在地区不可直连）` : item.label,
                  })),
                ]}
                onChange={(event) => {
                  const next = event.target.value;
                  setProvider(next);
                  const found = catalog.find((item) => item.provider === next);
                  setBaseUrl(found?.defaultBaseUrl ?? '');
                  setModels(found?.models ?? []);
                  setModel(found?.models[0] ?? '');
                  setStep('idle');
                  // 已知不可直连的供应商提前告知，不必等用户填完 Key 点测试才失败
                  setFeedback(
                    found?.regionNotice
                      ? { tone: 'warning', text: found.regionNotice }
                      : null,
                  );
                }}
              />
              <Input
                label="接口地址"
                name="baseUrl"
                placeholder={currentCatalog?.defaultBaseUrl ?? 'https://api.deepseek.com'}
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
              <Input
                label="API Key"
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder="sk-..."
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setStep('idle');
                }}
              />
              <div className={styles.fieldActions}>
                <Button
                  variant="secondary"
                  loading={test.isPending}
                  disabled={provider === 'mock'}
                  onClick={() => test.mutate()}
                >
                  测试连接
                </Button>
                <Button
                  variant="secondary"
                  loading={fetchModels.isPending}
                  disabled={provider === 'mock' || step === 'idle'}
                  onClick={() => fetchModels.mutate()}
                  title={step === 'idle' ? '请先测试连接' : ''}
                >
                  获取模型
                </Button>
              </div>
            </div>

            {step === 'idle' && provider !== 'mock' ? (
              <Banner tone="warning">
                <span>请先点「测试连接」。测试通过后「获取模型」才会启用——这样能确保模型列表来自真正可用的凭据。</span>
              </Banner>
            ) : null}

            {provider === 'mock' ? (
              <Banner tone="info">
                <span>离线占位不会调用任何外部接口，AI 功能会返回带「离线占位」字样的示例内容，适合演示与排查。</span>
              </Banner>
            ) : null}
          </Card>

          <Card title="选择默认模型">
            {models.length === 0 ? (
              <Banner tone="info">
                <span>还没有模型列表。点上面的「获取模型」从供应商拉取，或直接在下面手动填写模型标识。</span>
              </Banner>
            ) : null}

            {models.length > 0 ? (
              <div className={styles.modelList}>
                {models.map((item) => (
                  <label key={item} className={`${styles.modelItem} ${model === item ? styles.modelItemActive : ''}`}>
                    <input
                      type="radio"
                      name="model"
                      checked={model === item}
                      onChange={() => setModel(item)}
                    />
                    <span className={styles.modelName}>{item}</span>
                    {item === config.data?.model ? <Tag tone="success">当前</Tag> : null}
                  </label>
                ))}
              </div>
            ) : null}

            <div className={styles.formGrid} style={{ marginTop: 'var(--mf-space-4)' }}>
              <Input
                label="模型标识（也可手动填写）"
                name="model"
                placeholder="deepseek-v4-flash-0731"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </div>

            <div className={styles.footer}>
              <Button loading={save.isPending} disabled={!provider || !model || !dirty} onClick={() => save.mutate()}>
                保存并设为默认
              </Button>
              <Button variant="text" loading={offline.isPending} onClick={() => offline.mutate()}>
                切换为离线占位
              </Button>
              <span className={styles.desc}>
                {dirty ? '有未保存的改动' : '当前配置已是最新'}
              </span>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
