import { FillPayload } from './BasePlatformAdapter';
import { WechatVideoAdapter } from './adapters/WechatVideoAdapter';
import { XiaohongshuAdapter } from './adapters/XiaohongshuAdapter';

const adapters = [new XiaohongshuAdapter(), new WechatVideoAdapter()];

function activeAdapter(url: string) {
  return adapters.find((adapter) => adapter.canHandle(url));
}

chrome.runtime.onMessage.addListener((message: { type?: string; payload?: FillPayload }, _sender, sendResponse) => {
  if (message?.type !== 'mediaflow:fill' || !message.payload) return false;
  const adapter = activeAdapter(window.location.href);
  if (!adapter) {
    sendResponse({ ok: false, message: '当前页面不在支持的平台编辑器内' });
    return true;
  }
  const report = adapter.fill(document, message.payload);
  sendResponse({ ok: true, platform: adapter.platform, report });
  return true;
});

// Let the popup know a supported editor is open so it can enable the fill button.
chrome.runtime.sendMessage({ type: 'mediaflow:adapter-ready', platform: activeAdapter(window.location.href)?.platform ?? null });
