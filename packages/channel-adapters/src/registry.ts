import { PlatformCode } from '@mediaflow/shared';
import { BaijiahaoAdapter } from './adapters/baijiahao.adapter';
import { DouyinAdapter } from './adapters/douyin.adapter';
import { PluginFillAdapter } from './adapters/plugin-fill.adapter';
import { WechatMpAdapter } from './adapters/wechat-mp.adapter';
import { AdapterContext, ChannelAdapter } from './types';

/** Single source of truth for platform integrations. */
export class ChannelAdapterRegistry {
  private readonly adapters = new Map<PlatformCode, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  has(platform: PlatformCode): boolean {
    return this.adapters.has(platform);
  }

  get(platform: PlatformCode): ChannelAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`平台适配器尚未实现：${platform}`);
    return adapter;
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }
}

export interface DefaultRegistryOptions {
  context?: AdapterContext;
}

const PLUGIN_EDITOR_URLS: Partial<Record<PlatformCode, string>> = {
  [PlatformCode.WechatVideo]: 'https://channels.weixin.qq.com/platform/post/create',
  [PlatformCode.Zhihu]: 'https://zhuanlan.zhihu.com/write',
  [PlatformCode.Toutiao]: 'https://mp.toutiao.com/profile_v4/graphic/publish',
  [PlatformCode.Xiaohongshu]: 'https://creator.xiaohongshu.com/publish/publish',
};

export function createDefaultRegistry(options: DefaultRegistryOptions = {}): ChannelAdapterRegistry {
  const registry = new ChannelAdapterRegistry();
  registry.register(new WechatMpAdapter(options.context));
  registry.register(new DouyinAdapter(options.context));
  registry.register(new BaijiahaoAdapter(options.context));
  for (const [platform, editorUrl] of Object.entries(PLUGIN_EDITOR_URLS)) {
    registry.register(new PluginFillAdapter(platform as PlatformCode, editorUrl));
  }
  return registry;
}
