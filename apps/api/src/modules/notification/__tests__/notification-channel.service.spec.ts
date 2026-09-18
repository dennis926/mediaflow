import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyRuntimeConfig } from '../../settings/runtime-config';
import { NotificationChannelService } from '../notification-channel.service';

describe('通知渠道（群机器人 / 邮件）', () => {
  const service = new NotificationChannelService();
  const message = { title: '发布失败', text: '重试 3 次仍失败' };

  afterEach(() => {
    applyRuntimeConfig({});
    vi.unstubAllGlobals();
  });

  it('没有配置时不启用任何渠道', () => {
    applyRuntimeConfig({});
    expect(service.available()).toEqual([]);
  });

  it('配置了 Webhook 就启用 webhook 渠道', () => {
    applyRuntimeConfig({ NOTIFY_WEBHOOK_URL: 'https://oapi.dingtalk.com/robot/send?access_token=x' });
    expect(service.available()).toEqual(['webhook']);
  });

  it('邮件渠道需要同时有开关、SMTP 与收件人', () => {
    applyRuntimeConfig({ NOTIFY_EMAIL_ENABLED: 'true', NOTIFY_EMAIL_TO: 'ops@example.com' });
    expect(service.available()).toEqual([]);
    applyRuntimeConfig({ NOTIFY_EMAIL_ENABLED: 'true', NOTIFY_EMAIL_TO: 'ops@example.com', SMTP_HOST: 'smtp.qq.com' });
    expect(service.available()).toEqual(['email']);
  });

  it('按域名自动识别消息体格式', () => {
    const dingtalk = service.buildWebhookPayload(message, 'auto', 'https://oapi.dingtalk.com/robot/send?access_token=x');
    expect(dingtalk).toMatchObject({ msgtype: 'text' });

    const feishu = service.buildWebhookPayload(message, 'auto', 'https://open.feishu.cn/open-apis/bot/v2/hook/x');
    expect(feishu).toMatchObject({ msg_type: 'text' });

    const wecom = service.buildWebhookPayload(message, 'auto', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x');
    expect(wecom).toMatchObject({ msgtype: 'text' });

    const generic = service.buildWebhookPayload(message, 'auto', 'https://hooks.example.com/notify');
    expect(generic).toMatchObject({ title: '发布失败' });
  });

  it('显式指定类型时不再猜', () => {
    const payload = service.buildWebhookPayload(message, 'feishu', 'https://hooks.example.com/x');
    expect(payload).toMatchObject({ msg_type: 'text' });
  });

  it('Webhook 返回业务错误码也算失败（钉钉/飞书会 200 带错误码）', async () => {
    applyRuntimeConfig({ NOTIFY_WEBHOOK_URL: 'https://oapi.dingtalk.com/robot/send?access_token=x' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errcode: 310000, msg: '签名校验失败' }), { status: 200 })));

    const results = await service.dispatch(message);
    expect(results[0]).toMatchObject({ channel: 'webhook', ok: false });
    expect(results[0].error).toContain('签名校验失败');
  });

  it('Webhook 正常返回时成功', async () => {
    applyRuntimeConfig({ NOTIFY_WEBHOOK_URL: 'https://hooks.example.com/notify' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const results = await service.dispatch(message);
    expect(results[0]).toMatchObject({ channel: 'webhook', ok: true });
  });

  it('Webhook 网络异常不抛出（只返回失败）', async () => {
    applyRuntimeConfig({ NOTIFY_WEBHOOK_URL: 'https://hooks.example.com/notify' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect timeout');
    }));

    const results = await service.dispatch(message);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('connect timeout');
  });
});
