import { Injectable } from '@nestjs/common';
import { runtime } from '../settings/runtime-config';

export type NotifyChannel = 'webhook' | 'email';

export interface ChannelMessage {
  title: string;
  text: string;
  /** 便于排查：触发的业务对象 */
  context?: Record<string, unknown>;
}

/**
 * 通知渠道：站内通知之外的"推出去"能力。
 *
 * - 群机器人 Webhook：钉钉/飞书/企业微信/通用 JSON，自带按域名自动识别；
 * - 邮件：SMTP 直发（SSL / STARTTLS），QQ/163 用授权码即可。
 *
 * 所有发送失败只记日志，绝不阻断业务流程（发布、刷新令牌等）。
 */
@Injectable()
export class NotificationChannelService {
  /** 当前可用的渠道（配置了什么算什么）。 */
  available(): NotifyChannel[] {
    const config = runtime().notify;
    const channels: NotifyChannel[] = [];
    if (config.webhookUrl.trim()) channels.push('webhook');
    if (config.emailEnabled && config.smtp.host.trim() && config.emailTo.length > 0) channels.push('email');
    return channels;
  }

  /** 并发发到所有已配置渠道，返回每个渠道的结果。 */
  async dispatch(message: ChannelMessage): Promise<Array<{ channel: NotifyChannel; ok: boolean; error?: string }>> {
    const channels = this.available();
    const results = await Promise.all(
      channels.map(async (channel) => {
        if (channel === 'webhook') return { channel, ...(await this.sendWebhook(message)) };
        return { channel, ...(await this.sendEmail(message)) };
      }),
    );
    return results;
  }

  /** 组装群机器人消息体：按配置或按域名自动识别。 */
  buildWebhookPayload(message: ChannelMessage, type = runtime().notify.webhookType, url = runtime().notify.webhookUrl): Record<string, unknown> {
    const resolved =
      type !== 'auto'
        ? type
        : url.includes('dingtalk.com')
          ? 'dingtalk'
          : url.includes('feishu.cn') || url.includes('larksuite.com')
            ? 'feishu'
            : url.includes('weixin.qq.com')
              ? 'wecom'
              : 'generic';

    const line = `【${message.title}】${message.text}`;
    switch (resolved) {
      case 'dingtalk':
        return { msgtype: 'text', text: { content: line } };
      case 'feishu':
        return { msg_type: 'text', content: { text: line } };
      case 'wecom':
        return { msgtype: 'text', text: { content: line } };
      default:
        return { title: message.title, text: message.text, context: message.context ?? {} };
    }
  }

  private async sendWebhook(message: ChannelMessage): Promise<{ ok: boolean; error?: string }> {
    const config = runtime().notify;
    if (!config.webhookUrl.trim()) return { ok: false, error: '未配置 Webhook 地址' };
    try {
      const response = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildWebhookPayload(message)),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      // 钉钉/飞书即使 HTTP 200 也可能返回业务错误码
      const body = (await response.json().catch(() => null)) as { errcode?: number; code?: number; msg?: string } | null;
      const code = body?.errcode ?? body?.code;
      if (typeof code === 'number' && code !== 0) return { ok: false, error: body?.msg ?? `业务错误码 ${code}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async sendEmail(message: ChannelMessage): Promise<{ ok: boolean; error?: string }> {
    const config = runtime().notify;
    if (!config.emailEnabled) return { ok: false, error: '未启用邮件通知' };
    if (!config.smtp.host || config.emailTo.length === 0) return { ok: false, error: 'SMTP 或收件人未配置' };
    try {
      const nodemailer = await import('nodemailer');
      const transport = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
        connectionTimeout: 8000,
      });
      await transport.sendMail({
        from: config.smtp.fromName ? `"${config.smtp.fromName}" <${config.smtp.user}>` : config.smtp.user,
        to: config.emailTo.join(','),
        subject: `[${runtime().site.name}] ${message.title}`,
        text: `${message.text}\n\n${message.context ? JSON.stringify(message.context, null, 2) : ''}`,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
