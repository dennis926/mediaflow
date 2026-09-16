import { PlatformCode } from '@mediaflow/shared';
import { ChannelAdapter } from './types';

/** Single source of truth for platform integrations. */
export class ChannelAdapterRegistry {
  private readonly adapters = new Map<PlatformCode, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  get(platform: PlatformCode): ChannelAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`No channel adapter registered for platform: ${platform}`);
    return adapter;
  }

  has(platform: PlatformCode): boolean {
    return this.adapters.has(platform);
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }
}

export const channelAdapterRegistry = new ChannelAdapterRegistry();
