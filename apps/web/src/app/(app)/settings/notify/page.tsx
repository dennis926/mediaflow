'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Banner } from '../../../../components/ui/Banner';
import { Button } from '../../../../components/ui/Button';
import { Card } from '../../../../components/ui/Card';
import { Input, Select } from '../../../../components/ui/Field';
import { SkeletonRows } from '../../../../components/ui/Skeleton';
import { Switch } from '../../../../components/ui/Switch';
import { Tag } from '../../../../components/ui/Tag';
import { ApiError } from '../../../../lib/api/client';
import { channelsApi } from '../../../../lib/api/endpoints';
import type { ChannelFieldView, ChannelsView } from '../../../../lib/api/types';
import styles from '../page.module.css';

/** 一个渠道的配置项渲染（开关打开后才展开）。 */
function ChannelFields({
  fields,
  values,
  onChange,
}: {
  fields: ChannelFieldView[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className={styles.group}>
      {fields.map((field) => (
        <div className={styles.item} key={field.key}>
          <div className={styles.meta}>
            <span className={styles.label}>{field.label}</span>
            <span className={styles.desc}>{field.description}</span>
            {field.configured ? <Tag tone="success">已配置</Tag> : <Tag tone="warning">未配置</Tag>}
          </div>
          <div className={styles.controlRow}>
            {field.options ? (
              <Select
                name={field.key}
                options={field.options}
                value={values[field.key] ?? ''}
                onChange={(event) => onChange(field.key, event.target.value)}
              />
            ) : (
              <Input
                name={field.key}
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                placeholder={field.placeholder ?? (field.configured ? '' : '未配置')}
                value={values[field.key] ?? ''}
                onChange={(event) => onChange(field.key, event.target.value)}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 通知渠道（开关 + 勾选式）。
 *
 * 用户要求：「通知渠道用开关方式，打开哪个开关就编辑哪个通知方式，以勾选的方式，
 * 这样就算选择 2 个以上的通知都可以展现出来」。
 *
 * 所以渠道是平铺的开关卡片，可以同时打开多个，每个打开后各自展开自己的配置，
 * 互不影响，也不用担心"只能选一个"。
 */
export default function NotifyChannelsPage() {
  const queryClient = useQueryClient();
  const view = useQuery({ queryKey: ['channels', 'notify'], queryFn: () => channelsApi.notify() });

  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [globals, setGlobals] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);

  const hydrate = (data: ChannelsView) => {
    const nextEnabled: Record<string, boolean> = {};
    const nextValues: Record<string, string> = {};
    for (const channel of data.channels) {
      nextEnabled[channel.code] = channel.enabled;
      for (const field of channel.fields) nextValues[field.key] = field.value;
    }
    setEnabled(nextEnabled);
    setValues(nextValues);
    setGlobals(Object.fromEntries(data.globals.map((item) => [item.key, item.value])));
  };

  useEffect(() => {
    if (view.data) hydrate(view.data);
  }, [view.data]);

  const save = useMutation({
    mutationFn: () => channelsApi.saveNotify({ enabled, values, globals }),
    onSuccess: (data) => {
      hydrate(data);
      setFeedback({ tone: 'success', text: '通知渠道已保存并立即生效' });
      void queryClient.invalidateQueries({ queryKey: ['channels', 'notify'] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '保存失败' }),
  });

  const dirty =
    Boolean(view.data) &&
    (view.data!.channels.some((channel) => channel.enabled !== enabled[channel.code]) ||
      view.data!.channels.some((channel) =>
        channel.fields.some((field) => (values[field.key] ?? '') !== field.value),
      ) ||
      view.data!.globals.some((field) => (globals[field.key] ?? '') !== field.value));

  const activeCount = Object.values(enabled).filter(Boolean).length;

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

      {view.isLoading ? (
        <Card title="通知渠道">
          <SkeletonRows rows={6} />
        </Card>
      ) : (
        <>
          <Card title="通知渠道" extra={<Tag tone={activeCount > 0 ? 'success' : 'default'}>已启用 {activeCount} 个</Tag>}>
            <Banner tone="info">
              <span>
                可以同时打开多个渠道：打开哪个开关就编辑哪个渠道的配置，互不影响。
                关闭开关后配置会保留，下次打开不用重新填。
              </span>
            </Banner>

            {(view.data?.channels ?? []).map((channel) => (
              <div className={styles.channelCard} key={channel.code}>
                <div className={styles.channelHeader}>
                  <Switch
                    checked={Boolean(enabled[channel.code])}
                    onChange={(checked) => setEnabled({ ...enabled, [channel.code]: checked })}
                    label={channel.label}
                    hint={channel.description}
                  />
                  <div className={styles.channelStatus}>
                    {enabled[channel.code] ? (
                      channel.ready ? (
                        <Tag tone="success">已就绪</Tag>
                      ) : (
                        <Tag tone="warning">待完善</Tag>
                      )
                    ) : (
                      <Tag tone="default">未启用</Tag>
                    )}
                  </div>
                </div>
                {enabled[channel.code] ? (
                  <div className={styles.channelBody}>
                    {channel.fields.length > 0 ? (
                      <ChannelFields
                        fields={channel.fields}
                        values={values}
                        onChange={(key, value) => setValues({ ...values, [key]: value })}
                      />
                    ) : (
                      <Banner tone="info">
                        <span>该渠道无需额外配置，打开开关即可。</span>
                      </Banner>
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </Card>

          <Card title="通知规则">
            <div className={styles.group}>
              {(view.data?.globals ?? []).map((field) => (
                <div className={styles.item} key={field.key}>
                  <div className={styles.meta}>
                    <span className={styles.label}>{field.label}</span>
                    <span className={styles.desc}>{field.description}</span>
                  </div>
                  <div className={styles.controlRow}>
                    {field.options ? (
                      <Select
                        name={field.key}
                        options={field.options}
                        value={globals[field.key] ?? ''}
                        onChange={(event) => setGlobals({ ...globals, [field.key]: event.target.value })}
                      />
                    ) : (
                      <Input
                        name={field.key}
                        placeholder={field.placeholder}
                        value={globals[field.key] ?? ''}
                        onChange={(event) => setGlobals({ ...globals, [field.key]: event.target.value })}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div className={styles.footer}>
              <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
                保存{dirty ? '（有改动）' : ''}
              </Button>
              <Button variant="secondary" disabled={!dirty} onClick={() => view.data && hydrate(view.data)}>
                放弃修改
              </Button>
              <span className={styles.desc}>保存后会写入审计日志（只记录改了哪些项，不记录密钥内容）。</span>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
