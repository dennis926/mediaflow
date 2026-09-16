import { BasePlatformAdapter } from './BasePlatformAdapter';

const adapters: BasePlatformAdapter[] = [];

function pickAdapter(url: string): BasePlatformAdapter | undefined {
  return adapters.find((adapter) => adapter.canHandle(url));
}

chrome.runtime.onMessage.addListener((message: { type?: string; payload?: unknown }) => {
  if (message?.type !== 'mediaflow:fill') return;
  const adapter = pickAdapter(window.location.href);
  if (!adapter) return;
  void adapter.fill(message.payload as never);
});
