import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelAdapterRegistry, createDefaultRegistry } from '@mediaflow/channel-adapters';
import { RedisTokenStore } from './token-store.service';

export const CHANNEL_REGISTRY = 'CHANNEL_ADAPTER_REGISTRY';

export const channelRegistryProvider: Provider = {
  provide: CHANNEL_REGISTRY,
  inject: [ConfigService, RedisTokenStore],
  useFactory: (config: ConfigService, tokenStore: RedisTokenStore): ChannelAdapterRegistry =>
    createDefaultRegistry({
      context: { tokenStore },
      xiaohongshuBaseUrl: config.get<string>('XIAOHONGSHU_API_BASE') || undefined,
    }),
};
