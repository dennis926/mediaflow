'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Banner } from '../../../../components/ui/Banner';
import { Button } from '../../../../components/ui/Button';
import { Card } from '../../../../components/ui/Card';
import { Input } from '../../../../components/ui/Field';
import { SkeletonRows } from '../../../../components/ui/Skeleton';
import { Switch } from '../../../../components/ui/Switch';
import { Tag } from '../../../../components/ui/Tag';
import { ApiError } from '../../../../lib/api/client';
import { channelsApi } from '../../../../lib/api/endpoints';
import type { ChannelsView } from '../../../../lib/api/types';
import styles from '../page.module.css';

/**
 * 平台密钥（开关 + 勾选式）。
 *
 * 用户要求：「平台密钥同理」——和通知渠道一样，用开关决定"用不用这个平台"，
 * 打开后才展开该平台的凭据字段。同时打开多个平台互不干扰。
 *
 * 这里只配置"平台凭据"，真正的账号绑定在「账号管理」页（OAuth 授权）。
 */
export default function PlatformChannelsPage() {
  const queryClient = useQueryClient();
  const view = useQuery({ queryKey: ['channels', 'platform'], queryFn: () => channelsApi.platform() });

  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
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
  };

  useEffect(() => {
    if (view.data) hydrate(view.data);
  }, [view.data]);

  const save = useMutation({
    mutationFn: () => channelsApi.savePlatform({ enabled, values }),
    onSuccess: (data) => {
      hydrate(data);
      setFeedback({ tone: 'success', text: '平台配置已保存并立即生效' });
      void queryClient.invalidateQueries({ queryKey: ['channels', 'platform'] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '保存失败' }),
  });

  const dirty =
    Boolean(view.data) &&
    (view.data!.channels.some((channel) => channel.enabled !== enabled[channel.code]) ||
      view.data!.channels.some((channel) =>
        channel.fields.some((field) => (values[field.key] ?? '') !== field.value),
      ));

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
        <Card title="平台密钥">
          <SkeletonRows rows={6} />
        </Card>
      ) : (
        <>
          <Card title="平台密钥" extra={<Tag tone={activeCount > 0 ? 'success' : 'default'}>已启用 {activeCount} 个平台</Tag>}>
            <Banner tone="info">
              <span>
                打开开关表示「这个平台要接入」。打开后展开填写该平台的凭据（加密存储，界面只显示后四位）。
                没有官方发布接口的平台（视频号、知乎、头条等）不需要填凭据，用浏览器插件半自动发布。
                实际账号授权在「账号管理」里完成。
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
                    {!enabled[channel.code] ? (
                      <Tag tone="default">未启用</Tag>
                    ) : channel.fields.length === 0 ? (
                      <Tag tone="info">插件发布</Tag>
                    ) : channel.ready ? (
                      <Tag tone="success">凭据已填</Tag>
                    ) : (
                      <Tag tone="warning">待完善</Tag>
                    )}
                  </div>
                </div>
                {enabled[channel.code] && channel.fields.length > 0 ? (
                  <div className={styles.channelBody}>
                    <div className={styles.group}>
                      {channel.fields.map((field) => (
                        <div className={styles.item} key={field.key}>
                          <div className={styles.meta}>
                            <span className={styles.label}>{field.label}</span>
                            <span className={styles.desc}>{field.description}</span>
                            {field.configured ? <Tag tone="success">已配置</Tag> : <Tag tone="warning">未配置</Tag>}
                          </div>
                          <div className={styles.controlRow}>
                            <Input
                              name={field.key}
                              type={field.secret ? 'password' : 'text'}
                              autoComplete="off"
                              placeholder={field.placeholder ?? (field.configured ? '' : '未配置')}
                              value={values[field.key] ?? ''}
                              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </Card>

          <Card>
            <div className={styles.footer}>
              <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
                保存{dirty ? '（有改动）' : ''}
              </Button>
              <Button variant="secondary" disabled={!dirty} onClick={() => view.data && hydrate(view.data)}>
                放弃修改
              </Button>
              <span className={styles.desc}>留空即表示清除后台配置、回退到 .env；密钥内容不会写进审计日志。</span>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
