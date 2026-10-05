import { BadRequestException, Body, Controller, Get, Put } from '@nestjs/common';
import { toActor } from '../auth/actor.util';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Capability } from '../auth/capabilities';
import { SettingsService } from './settings.service';

export interface ChannelFieldView {
  key: string;
  label: string;
  description: string;
  secret: boolean;
  value: string;
  configured: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface ChannelView {
  code: string;
  label: string;
  description: string;
  /** 开关状态：用户勾选"启用"即为 true */
  enabled: boolean;
  /** 该渠道的配置项（开关打开时才展开编辑） */
  fields: ChannelFieldView[];
  /** 是否已填齐必要配置，界面上给一个"已就绪/待完善"的提示 */
  ready: boolean;
}

export interface ChannelsView {
  channels: ChannelView[];
  /** 全局项（不绑定到某个渠道的公共配置） */
  globals: ChannelFieldView[];
}

/** 渠道定义：开关 key + 展开后要填的字段。 */
const NOTIFY_CHANNELS = [
  {
    code: 'webhook',
    label: '群机器人',
    description: '钉钉 / 飞书 / 企业微信群机器人。填 Webhook 地址即可，发布失败、账号掉线时推送到群里。',
    enabledKey: 'NOTIFY_CHANNEL_WEBHOOK',
    fields: ['NOTIFY_WEBHOOK_URL', 'NOTIFY_WEBHOOK_TYPE'],
    required: ['NOTIFY_WEBHOOK_URL'],
  },
  {
    code: 'email',
    label: '邮件',
    description: 'SMTP 发信。适合需要留档、或群里没人看的时候兜底。',
    enabledKey: 'NOTIFY_CHANNEL_EMAIL',
    fields: ['NOTIFY_EMAIL_TO', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'],
    required: ['NOTIFY_EMAIL_TO', 'SMTP_HOST', 'SMTP_USER'],
  },
];

const PLATFORM_CHANNELS = [
  { code: 'wechat_mp', label: '微信公众号', description: '内容创作辅助 + 人工发布（禁止 API 自动发布）。', enabledKey: 'PLATFORM_CHANNEL_WECHAT_MP', fields: ['WECHAT_MP_APP_ID', 'WECHAT_MP_APP_SECRET'], required: ['WECHAT_MP_APP_ID'] },
  { code: 'wechat_video', label: '视频号', description: '无官方发布 API，走浏览器插件半自动发布。', enabledKey: 'PLATFORM_CHANNEL_WECHAT_VIDEO', fields: [], required: [] },
  { code: 'douyin', label: '抖音', description: '开放平台视频发布 API（需 OAuth 授权）。', enabledKey: 'PLATFORM_CHANNEL_DOUYIN', fields: ['DOUYIN_CLIENT_KEY', 'DOUYIN_CLIENT_SECRET'], required: ['DOUYIN_CLIENT_KEY'] },
  { code: 'xiaohongshu', label: '小红书', description: '笔记发布 API（需企业资质）；未认证自动降级插件。', enabledKey: 'PLATFORM_CHANNEL_XIAOHONGSHU', fields: ['XIAOHONGSHU_APP_ID', 'XIAOHONGSHU_APP_SECRET', 'XIAOHONGSHU_API_BASE'], required: ['XIAOHONGSHU_APP_ID'] },
  { code: 'zhihu', label: '知乎', description: '官方发布 API 已关闭，走浏览器插件。', enabledKey: 'PLATFORM_CHANNEL_ZHIHU', fields: [], required: [] },
  { code: 'toutiao', label: '今日头条', description: '无官方发布 API，走浏览器插件。', enabledKey: 'PLATFORM_CHANNEL_TOUTIAO', fields: [], required: [] },
  { code: 'baijiahao', label: '百家号', description: '官方 article/publish 接口，可直接发布。', enabledKey: 'PLATFORM_CHANNEL_BAIJIAHAO', fields: ['BAIJIAHAO_APP_ID', 'BAIJIAHAO_APP_TOKEN'], required: ['BAIJIAHAO_APP_ID', 'BAIJIAHAO_APP_TOKEN'] },
  { code: 'qi_e', label: '企鹅号', description: '仅"内容网站"自用模式提供接口。', enabledKey: 'PLATFORM_CHANNEL_QI_E', fields: [], required: [] },
];

/**
 * 通知渠道与平台密钥的「开关 + 勾选」配置。
 *
 * 用户要求：通知渠道用开关方式，打开哪个开关就编辑哪个通知方式，勾选式，
 * 这样同时选 2 个以上也能各自展开；平台密钥同理。
 *
 * 关键点：开关本身也是一个配置项（NOTIFY_CHANNEL_* / PLATFORM_CHANNEL_*），
 * 所以它会被运行时快照读到，业务代码可以用它判断"这个渠道到底启不启用"，
 * 而不是只看字段填没填。
 */
@Controller('channels')
export class ChannelsController {
  constructor(private readonly settings: SettingsService) {}

  @Capability('settings.write')
  @Get('notify')
  async notify(): Promise<ChannelsView> {
    return this.build(NOTIFY_CHANNELS, 'NOTIFY_EMAIL_ENABLED');
  }

  @Capability('settings.write')
  @Put('notify')
  async saveNotify(
    @Body() body: { enabled?: Record<string, boolean>; values?: Record<string, string>; globals?: Record<string, string> },
    @CurrentUser() user?: AuthUser,
  ): Promise<ChannelsView> {
    const items = await this.collect(NOTIFY_CHANNELS, body);
    if (items.length > 0) await this.settings.updateMany(items, toActor(user));
    return this.notify();
  }

  @Capability('settings.write')
  @Get('platform')
  async platform(): Promise<ChannelsView> {
    return this.build(PLATFORM_CHANNELS);
  }

  @Capability('settings.write')
  @Put('platform')
  async savePlatform(
    @Body() body: { enabled?: Record<string, boolean>; values?: Record<string, string> },
    @CurrentUser() user?: AuthUser,
  ): Promise<ChannelsView> {
    const items = await this.collect(PLATFORM_CHANNELS, body);
    if (items.length > 0) await this.settings.updateMany(items, toActor(user));
    return this.platform();
  }

  private async build(
    definitions: typeof NOTIFY_CHANNELS,
    legacyEnabledKey?: string,
  ): Promise<ChannelsView> {
    const views: ChannelView[] = [];
    for (const definition of definitions) {
      const raw = await this.settings.get(definition.enabledKey);
      let enabled: boolean;
      if (raw === null) {
        // 兼容：没有渠道开关时，回退到旧的总开关/字段是否已填
        if (legacyEnabledKey) {
          const legacy = await this.settings.get(legacyEnabledKey);
          enabled = legacy === 'true';
        } else {
          enabled = await this.hasAnyConfigured(definition.fields);
        }
      } else {
        enabled = raw === 'true';
      }

      const fields: ChannelFieldView[] = [];
      for (const key of definition.fields) {
        const field = await this.field(key);
        if (field) fields.push(field);
      }
      const ready = definition.required.every((key) => {
        const field = fields.find((item) => item.key === key);
        return Boolean(field?.configured);
      });

      views.push({
        code: definition.code,
        label: definition.label,
        description: definition.description,
        enabled,
        fields,
        ready,
      });
    }

    const globals: ChannelFieldView[] = [];
    for (const key of ['NOTIFY_MIN_LEVEL', 'NOTIFY_ON_PUBLISH_FAILURE', 'ACCOUNT_EXPIRY_WARN_DAYS']) {
      const field = await this.field(key);
      if (field) globals.push(field);
    }

    return { channels: views, globals };
  }

  /** 把界面提交的开关与字段值组装成待保存的配置项。 */
  private async collect(
    definitions: typeof NOTIFY_CHANNELS,
    body: { enabled?: Record<string, boolean>; values?: Record<string, string>; globals?: Record<string, string> },
  ): Promise<Array<{ key: string; value: string }>> {
    const items: Array<{ key: string; value: string }> = [];
    const allowed = new Set<string>();
    for (const definition of definitions) {
      allowed.add(definition.enabledKey);
      for (const key of definition.fields) allowed.add(key);
    }
    for (const key of ['NOTIFY_MIN_LEVEL', 'NOTIFY_ON_PUBLISH_FAILURE', 'ACCOUNT_EXPIRY_WARN_DAYS']) allowed.add(key);

    for (const [code, enabled] of Object.entries(body?.enabled ?? {})) {
      const definition = definitions.find((item) => item.code === code);
      if (!definition) throw new BadRequestException(`未知渠道：${code}`);
      items.push({ key: definition.enabledKey, value: enabled ? 'true' : 'false' });
    }

    const incoming = { ...(body?.values ?? {}), ...(body?.globals ?? {}) };
    for (const [key, value] of Object.entries(incoming)) {
      if (!allowed.has(key)) throw new BadRequestException(`未知配置项：${key}`);
      const trimmed = String(value ?? '').trim();
      // 打码值代表"不修改"，交给 SettingsService 的既有逻辑忽略
      if (trimmed.startsWith('••••')) continue;
      items.push({ key, value: trimmed });
    }

    return items;
  }

  private async field(key: string): Promise<ChannelFieldView | null> {
    const groups = await this.settings.list();
    for (const group of groups) {
      const item = group.items.find((entry) => entry.key === key);
      if (item) {
        return {
          key: item.key,
          label: item.label,
          description: item.description,
          secret: item.secret,
          value: item.value,
          configured: item.configured,
          placeholder: item.placeholder,
          options: item.options,
        };
      }
    }
    return null;
  }

  private async hasAnyConfigured(keys: string[]): Promise<boolean> {
    for (const key of keys) {
      const value = await this.settings.get(key);
      if (value !== null && value.trim() !== '') return true;
    }
    return false;
  }
}
