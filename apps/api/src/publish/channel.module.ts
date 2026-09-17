import { Global, Module } from '@nestjs/common';
import { channelRegistryProvider } from './channel-registry.provider';
import { RedisTokenStore } from './token-store.service';

/**
 * Holds the channel adapter registry and its Redis token cache.
 * Global on purpose: both PublishModule and PlatformModule need it, and keeping it here avoids a
 * circular module dependency between them.
 */
@Global()
@Module({
  providers: [RedisTokenStore, channelRegistryProvider],
  exports: [RedisTokenStore, channelRegistryProvider],
})
export class ChannelModule {}
