'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PLATFORM_LABELS, PlatformCode, PublishMode } from '@mediaflow/shared';
import { useEffect, useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { Dialog } from '../../../components/ui/Dialog';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Input, Select } from '../../../components/ui/Field';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { ApiError } from '../../../lib/api/client';
import { accountsApi } from '../../../lib/api/endpoints';
import type { AccountView } from '../../../lib/api/types';
import { formatDateTime } from '../../../lib/format';
import { AccountIcon, PlusIcon, TrashIcon } from '../../../lib/icons';
import styles from './page.module.css';

const PLATFORM_OPTIONS = Object.values(PlatformCode).map((platform) => ({
  value: platform,
  label: PLATFORM_LABELS[platform],
}));

const MODE_LABELS: Record<PublishMode, string> = {
  [PublishMode.Api]: '官方接口发布',
  [PublishMode.Plugin]: '插件半自动',
  [PublishMode.Manual]: '人工发布',
};

/** Platforms that support the browser OAuth flow; others bind with the extension or a manual token. */
const OAUTH_PLATFORMS: PlatformCode[] = [PlatformCode.WechatMp, PlatformCode.Douyin, PlatformCode.Xiaohongshu];

function AccountsPageInner() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const [bindOpen, setBindOpen] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [pendingUnbind, setPendingUnbind] = useState<AccountView | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);
  const [form, setForm] = useState({
    platform: PlatformCode.WechatMp as PlatformCode,
    accountName: '',
    platformAccountId: '',
    accessToken: '',
    refreshToken: '',
  });

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });

  /** 手动登记（无密钥）：只记元信息，发布走插件/人工 */
  const [manualForm, setManualForm] = useState({ platform: PlatformCode.WechatVideo as PlatformCode, accountName: '', homepage: '', note: '' });
  const registerManual = useMutation({
    mutationFn: () =>
      accountsApi.registerManual({
        platform: manualForm.platform,
        accountName: manualForm.accountName.trim(),
        homepage: manualForm.homepage.trim() || undefined,
        note: manualForm.note.trim() || undefined,
      }),
    onSuccess: (account) => {
      setManualOpen(false);
      setManualForm({ platform: PlatformCode.WechatVideo as PlatformCode, accountName: '', homepage: '', note: '' });
      setFeedback({ tone: 'success', text: `已登记「${account.accountName}」：没有 API 凭证，发布将走插件填充或人工确认` });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '登记失败' }),
  });

  useEffect(() => {
    const result = searchParams.get('oauth');
    if (!result) return;
    const platform = searchParams.get('platform') ?? '';
    const message = searchParams.get('message') ?? '';
    setFeedback(
      result === 'ok'
        ? { tone: 'success', text: `${PLATFORM_LABELS[platform as PlatformCode] ?? platform} 授权成功：${message}` }
        : { tone: 'danger', text: `授权未完成：${message || '请重试'}` },
    );
    void queryClient.invalidateQueries({ queryKey: ['accounts'] });
  }, [searchParams, queryClient]);

  const authorize = useMutation({
    mutationFn: (platform: string) => accountsApi.oauthAuthorize(platform),
    onSuccess: (result) => {
      window.location.href = result.authorizeUrl;
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '无法发起授权' }),
  });

  const bind = useMutation({
    mutationFn: () =>
      accountsApi.bind({
        platform: form.platform,
        accountName: form.accountName.trim(),
        platformAccountId: form.platformAccountId.trim(),
        accessToken: form.accessToken.trim() || undefined,
        refreshToken: form.refreshToken.trim() || undefined,
      }),
    onSuccess: (account) => {
      setBindOpen(false);
      setFeedback({ tone: 'success', text: `已绑定：${account.accountName}（${account.platformName}）` });
      setForm({ platform: PlatformCode.WechatMp, accountName: '', platformAccountId: '', accessToken: '', refreshToken: '' });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '绑定失败' }),
  });

  const unbind = useMutation({
    mutationFn: (id: string) => accountsApi.unbind(id),
    onSuccess: () => {
      setPendingUnbind(null);
      setFeedback({ tone: 'info', text: '已解绑该账号' });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '解绑失败' }),
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

      <Card
        title="已绑定平台账号"
        extra={
          <div style={{ display: 'flex', gap: 'var(--mf-space-2)', flexWrap: 'wrap' }}>
            <Button size="sm" variant="secondary" onClick={() => setOauthOpen(true)}>
              平台授权绑定
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setManualOpen(true)}>
              手动登记（无密钥）
            </Button>
            <Button size="sm" icon={<PlusIcon width={15} height={15} />} onClick={() => setBindOpen(true)}>
              手动填写令牌
            </Button>
          </div>
        }
      >
        {accounts.isLoading ? (
          <SkeletonRows rows={4} />
        ) : accounts.data && accounts.data.length > 0 ? (
          <div className={styles.grid}>
            {accounts.data.map((account) => (
              <article className={styles.accountCard} key={account.id}>
                <div className={styles.cardTop}>
                  <span className={styles.avatar}>{account.accountName.slice(0, 1)}</span>
                  <span className={styles.name}>
                    <strong>{account.accountName}</strong>
                    <span className={styles.meta}>{account.platformName}</span>
                  </span>
                </div>
                <div className={styles.tags}>
                  <Tag tone="info">{MODE_LABELS[account.publishMode]}</Tag>
                  <Tag tone={account.hasToken ? 'success' : 'warning'}>{account.hasToken ? '令牌已配置' : '未配置令牌'}</Tag>
                  {account.status === 'expired' ? <Tag tone="danger">授权已失效，请重新绑定</Tag> : null}
                </div>
                <span className={styles.meta}>平台账号 ID：{account.platformAccountId}</span>
                <span className={styles.meta}>
                  {account.tokenExpiresAt ? `令牌到期：${formatDateTime(account.tokenExpiresAt)}` : '绑定时间：' + formatDateTime(account.createdAt)}
                  {account.tokenExpiresAt && account.status !== 'expired' && new Date(account.tokenExpiresAt).getTime() - Date.now() < 7 * 86_400_000
                    ? ' · 即将到期，建议提前重新授权'
                    : ''}
                </span>
                <div className={styles.actions}>
                  {OAUTH_PLATFORMS.includes(account.platform) ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={authorize.isPending && authorize.variables === account.platform}
                      onClick={() => authorize.mutate(account.platform)}
                    >
                      重新授权
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="text"
                    icon={<TrashIcon width={15} height={15} />}
                    onClick={() => setPendingUnbind(account)}
                  >
                    解绑
                  </Button>
                </div>
              </article>
            ))}
            <button type="button" className={styles.addCard} onClick={() => setManualOpen(true)}>
              <PlusIcon width={20} height={20} />
              <span>绑定新账号</span>
            </button>
          </div>
        ) : (
          <EmptyState
            title="还没有绑定平台账号"
            description="绑定后发布任务才能带账号执行：公众号用于取数，抖音/小红书用于 API 发布。"
            icon={<AccountIcon width={22} height={22} />}
            action={
              <div style={{ display: 'flex', gap: 'var(--mf-space-2)' }}>
                <Button size="sm" variant="secondary" onClick={() => setOauthOpen(true)}>
                  平台授权绑定
                </Button>
                <Button size="sm" icon={<PlusIcon width={15} height={15} />} onClick={() => setBindOpen(true)}>
                  手动填写令牌
                </Button>
              </div>
            }
          />
        )}
      </Card>

      <Dialog
        open={manualOpen}
        title="手动登记平台账号（无需密钥）"
        onClose={() => setManualOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setManualOpen(false)}>
              取消
            </Button>
            <Button loading={registerManual.isPending} disabled={!manualForm.accountName.trim()} onClick={() => registerManual.mutate()}>
              登记账号
            </Button>
          </>
        }
      >
        <p style={{ margin: '0 0 var(--mf-space-4)', fontSize: 'var(--mf-font-size-sm)', color: 'var(--mf-color-text-secondary)' }}>
          还没有平台的 AppID/密钥时用这里：只登记账号信息（不保存任何 token），发布走<strong>浏览器插件填充</strong>或
          <strong>人工发布后回填</strong>。拿到资质后可解绑，再走正式授权绑定升级为接口发布。
        </p>
        <div style={{ display: 'grid', gap: 'var(--mf-space-3)' }}>
          <Select
            label="平台"
            name="manualPlatform"
            options={PLATFORM_OPTIONS}
            value={manualForm.platform}
            onChange={(event) => setManualForm({ ...manualForm, platform: event.target.value as PlatformCode })}
          />
          <Input
            label="账号名称"
            name="manualAccountName"
            placeholder="例如：卿尔美健康号"
            value={manualForm.accountName}
            onChange={(event) => setManualForm({ ...manualForm, accountName: event.target.value })}
          />
          <Input
            label="主页链接（可选）"
            name="manualHomepage"
            placeholder="https://..."
            value={manualForm.homepage}
            onChange={(event) => setManualForm({ ...manualForm, homepage: event.target.value })}
          />
          <Input
            label="备注（可选）"
            name="manualNote"
            placeholder="例如：主要发科普内容，粉丝 1.2 万"
            value={manualForm.note}
            onChange={(event) => setManualForm({ ...manualForm, note: event.target.value })}
          />
        </div>
      </Dialog>

      <Dialog
        open={oauthOpen}
        title="平台授权绑定"
        onClose={() => setOauthOpen(false)}
        footer={
          <Button variant="secondary" onClick={() => setOauthOpen(false)}>
            关闭
          </Button>
        }
      >
        <Banner tone="info">
          <span>
            点击平台后会跳转到官方授权页，授权成功后自动回到本页并绑定账号。需先在「系统设置 → 平台密钥」填写对应平台的 AppID/Secret；
            平台后台登记的回调地址为：<code>{`{站点地址}/api/accounts/oauth/<平台>/callback`}</code>
          </span>
        </Banner>
        {OAUTH_PLATFORMS.map((platform) => (
          <div key={platform} className={styles.oauthRow}>
            <span>{PLATFORM_LABELS[platform]}</span>
            <Button
              size="sm"
              loading={authorize.isPending && authorize.variables === platform}
              onClick={() => authorize.mutate(platform)}
            >
              去授权
            </Button>
          </div>
        ))}
        <Banner tone="warning">
          <span>公众号只能人工发布（平台规则），授权用于取数；抖音/小红书授权后可直接发布；视频号等仍走浏览器插件。</span>
        </Banner>
      </Dialog>

      <Dialog
        open={bindOpen}
        title="绑定平台账号"
        onClose={() => setBindOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setBindOpen(false)}>
              取消
            </Button>
            <Button
              loading={bind.isPending}
              disabled={!form.accountName.trim() || !form.platformAccountId.trim()}
              onClick={() => bind.mutate()}
            >
              保存
            </Button>
          </>
        }
      >
        <Select
          label="平台"
          name="platform"
          options={PLATFORM_OPTIONS}
          value={form.platform}
          onChange={(event) => setForm({ ...form, platform: event.target.value as PlatformCode })}
        />
        <Input
          label="账号名称"
          name="accountName"
          placeholder="例如：官方账号"
          value={form.accountName}
          onChange={(event) => setForm({ ...form, accountName: event.target.value })}
        />
        <Input
          label="平台账号 ID"
          name="platformAccountId"
          placeholder="平台侧唯一标识（openid / 账号 ID）"
          value={form.platformAccountId}
          onChange={(event) => setForm({ ...form, platformAccountId: event.target.value })}
        />
        <Input
          label="Access Token（可选）"
          name="accessToken"
          type="password"
          placeholder="通过平台 OAuth 授权得到，留空表示稍后补"
          value={form.accessToken}
          onChange={(event) => setForm({ ...form, accessToken: event.target.value })}
        />
        <Input
          label="Refresh Token（可选）"
          name="refreshToken"
          type="password"
          value={form.refreshToken}
          onChange={(event) => setForm({ ...form, refreshToken: event.target.value })}
        />
        <Banner tone="info">
          <span>
            令牌会加密保存在数据库中、界面不回显。公众号仅用于拉取图文数据（平台禁止 API 自动发布）；抖音/小红书需要真实 OAuth 令牌才能发布。
          </span>
        </Banner>
      </Dialog>

      <Dialog
        open={Boolean(pendingUnbind)}
        title="解绑账号"
        onClose={() => setPendingUnbind(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingUnbind(null)}>
              取消
            </Button>
            <Button variant="danger" loading={unbind.isPending} onClick={() => pendingUnbind && unbind.mutate(pendingUnbind.id)}>
              确认解绑
            </Button>
          </>
        }
      >
        <span>解绑后，该账号的发布任务将无法执行，已发布内容不受影响。确定解绑「{pendingUnbind?.accountName}」吗？</span>
      </Dialog>
    </>
  );
}

export default function AccountsPage() {
  return (
    <Suspense fallback={<Card title="已绑定平台账号"><SkeletonRows rows={3} /></Card>}>
      <AccountsPageInner />
    </Suspense>
  );
}
