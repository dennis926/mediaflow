import { describe, expect, it } from 'vitest';
import { XiaohongshuAdapter } from '../content/adapters/XiaohongshuAdapter';
import { WechatVideoAdapter } from '../content/adapters/WechatVideoAdapter';
import type { DomLike, ElementLike } from '../content/BasePlatformAdapter';

function fakeElement(
  attributes: Record<string, string> = {},
  options: { withValue?: boolean } = {},
): ElementLike & { events: string[] } {
  const events: string[] = [];
  const element: ElementLike & { events: string[] } = {
    textContent: '',
    events,
    setAttribute(name, value) {
      attributes[name] = value;
    },
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    dispatchEvent(event: unknown) {
      events.push((event as Event).type);
      return true;
    },
  };
  // Real contenteditable divs have no `value` property; inputs/textarea do.
  if (options.withValue !== false) element.value = '';
  return element;
}

function fakeDocument(elements: Record<string, ElementLike>): DomLike {
  const inputs = Object.entries(elements)
    .filter(([key]) => key.startsWith('input:') || key.startsWith('textarea:'))
    .map(([, element]) => element);
  return {
    querySelector: (selector) => elements[selector] ?? null,
    querySelectorAll: (selector) =>
      selector.includes('input') || selector.includes('textarea') ? inputs : [],
  };
}

const payload = { title: '秋季肠道健康指南', body: '正文内容', tags: ['肠道健康', '膳食纤维'] };

describe('XiaohongshuAdapter', () => {
  it('fills the title and body editor with hashtags', () => {
    const title = fakeElement({ placeholder: '填写标题' });
    const body = fakeElement({}, { withValue: false });
    const document = fakeDocument({ 'input:text': title, 'div[contenteditable="true"]': body });

    const adapter = new XiaohongshuAdapter();
    const report = adapter.fill(document, payload);

    expect(report.filled).toEqual(expect.arrayContaining(['title', 'body']));
    expect(String(body.textContent)).toContain('#肠道健康');
    expect(title.value).toBe('秋季肠道健康指南');
  });

  it('reports missing fields instead of silently doing nothing', () => {
    const document = fakeDocument({ 'input:text': fakeElement({ placeholder: '搜索' }) });
    const adapter = new XiaohongshuAdapter();

    const report = adapter.fill(document, payload);

    expect(report.missing).toEqual(expect.arrayContaining(['title', 'body']));
  });

  it('only claims the creator host', () => {
    const adapter = new XiaohongshuAdapter();
    expect(adapter.canHandle('https://creator.xiaohongshu.com/publish/publish')).toBe(true);
    expect(adapter.canHandle('https://weibo.com/upload')).toBe(false);
  });
});

describe('WechatVideoAdapter', () => {
  it('fills the description editor and dispatches input events', () => {
    const description = fakeElement({ placeholder: '添加描述' });
    const document = fakeDocument({ 'textarea:textarea': description });

    const adapter = new WechatVideoAdapter();
    const report = adapter.fill(document, payload);

    expect(report.filled).toContain('description');
    expect((description as unknown as { events: string[] }).events).toContain('input');
    expect(String(description.value)).toContain('正文内容');
  });

  it('matches the channels host only', () => {
    const adapter = new WechatVideoAdapter();
    expect(adapter.canHandle('https://channels.weixin.qq.com/platform/post/create')).toBe(true);
    expect(adapter.canHandle('https://mp.weixin.qq.com/')).toBe(false);
  });
});
