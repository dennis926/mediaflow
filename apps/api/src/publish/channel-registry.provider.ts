import { Provider } from '@nestjs/common';
import { ChannelAdapterRegistry, createDefaultRegistry } from '@mediaflow/channel-adapters';
import { RedisTokenStore } from './token-store.service';

export const CHANNEL_REGISTRY = 'CHANNEL_ADAPTER_REGISTRY';

export const channelRegistryProvider: Provider = {
  provide: CHANNEL_REGISTRY,
  inject: [RedisTokenStore],
  useFactory: (tokenStore: RedisTokenStore): ChannelAdapterRegistry =>
    createDefaultRegistry({ context: { tokenStore } }),
};
