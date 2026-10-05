import { describe, expect, it, vi } from 'vitest';
import { DeepSeekProvider } from '../providers/deepseek.provider';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('DeepSeekProvider', () => {
  it('sends a chat completion request and reads usage counters', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        model: 'deepseek-chat',
        choices: [{ message: { content: '你好' } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    );
    const provider = new DeepSeekProvider({ apiKey: 'sk-test', model: 'deepseek-chat', fetchImpl });

    const result = await provider.complete({ task: 'generate', system: 'sys', user: 'hi' });

    expect(result.text).toBe('你好');
    expect(result.tokensInput).toBe(11);
    expect(result.tokensOutput).toBe(7);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body)) as { model: string; messages: unknown[] };
    expect(body.model).toBe('deepseek-chat');
    expect(body.messages).toHaveLength(2);
  });

  it('requests a JSON object response when the task needs structured output', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '{}' } }] }));
    const provider = new DeepSeekProvider({ apiKey: 'sk-test', model: 'deepseek-chat', fetchImpl });

    await provider.complete({ task: 'adapt', system: 'sys', user: 'hi', json: true });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { response_format?: { type: string } };
    expect(body.response_format?.type).toBe('json_object');
  });

  it('fails loudly when the API key is missing', async () => {
    const provider = new DeepSeekProvider({ apiKey: '', model: 'deepseek-chat', fetchImpl: vi.fn() });
    await expect(provider.complete({ task: 'generate', system: 's', user: 'u' })).rejects.toThrow(
      '未配置 DeepSeek 的 API Key',
    );
  });

  it('surfaces the platform error message alongside our own guidance', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'Invalid token' } }, 401));
    const provider = new DeepSeekProvider({ apiKey: 'sk-test', model: 'deepseek-chat', fetchImpl });

    // 中文提示要给出方向，但供应商原文必须保留 —— 排障时丢掉原文就无从判断是哪一类失败
    const error = await provider
      .complete({ task: 'generate', system: 's', user: 'u' })
      .catch((e: Error) => e.message);
    expect(error).toContain('鉴权失败');
    expect(error).toContain('Invalid token');
  });
});
