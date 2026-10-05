import { describe, expect, it } from 'vitest';
import { DeepSeekProvider } from '../providers/deepseek.provider';

/**
 * 报错文案必须说清「是哪个供应商」和「接下来怎么办」。
 *
 * 真实故障：用户在生产上新增了一个 OpenAI 供应商，测试连接失败，界面显示
 * "DeepSeek 接口返回 HTTP 403：Country, region, or territory not supported"。
 * 两个问题：① 明明测的是 OpenAI，标题却写 DeepSeek（模板里的供应商名写死了）；
 *          ② 直接把英文原文抛给用户，看不出是地区封锁，只会让人反复重填 Key。
 */

function provider(options: { providerId: string; status: number; body: unknown }) {
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify(options.body), {
      status: options.status,
      headers: { 'Content-Type': 'application/json' },
    });
  return new DeepSeekProvider({
    apiKey: 'sk-test',
    model: 'gpt-5.5',
    providerId: options.providerId,
    fetchImpl: fetchImpl as (input: string, init?: RequestInit) => Promise<Response>,
  });
}

describe('供应商 HTTP 报错翻译', () => {
  it('OpenAI 地域封锁要说明地区问题并指出换 Key 无效', async () => {
    const p = provider({
      providerId: 'openai',
      status: 403,
      body: {
        error: {
          code: 'unsupported_country_region_territory',
          message: 'Country, region, or territory not supported',
        },
      },
    });
    const error = await p.complete({ task: 'generate', system: 's', user: 'u' }).catch((e: Error) => e.message);
    expect(error).toContain('OpenAI');
    expect(error).not.toContain('DeepSeek 接口');
    expect(error).toMatch(/地区/);
    // 关键：必须明确告诉用户换 Key 没用，否则会一直重填
    expect(error).toMatch(/换 Key 也无效/);
  });

  it('Claude / Gemini 的地域封锁措辞同样被识别', async () => {
    const anthropic = provider({
      providerId: 'anthropic',
      status: 403,
      body: { error: { type: 'forbidden', message: 'Request not allowed' } },
    });
    const a = await anthropic.complete({ task: 'generate', system: 's', user: 'u' }).catch((e: Error) => e.message);
    expect(a).toContain('Claude');
    expect(a).toMatch(/地区/);

    const google = provider({
      providerId: 'google',
      status: 403,
      body: { error: { code: 403, message: "Method doesn't allow unregistered callers" } },
    });
    const g = await google.complete({ task: 'generate', system: 's', user: 'u' }).catch((e: Error) => e.message);
    expect(g).toContain('Gemini');
  });

  it('401 是 Key 问题，不能误报成地区限制', async () => {
    const p = provider({
      providerId: 'openai',
      status: 401,
      body: { error: { message: 'Incorrect API key provided' } },
    });
    const error = await p.complete({ task: 'generate', system: 's', user: 'u' }).catch((e: Error) => e.message);
    expect(error).toMatch(/鉴权失败/);
    expect(error).toMatch(/Key/);
    expect(error).not.toMatch(/换 Key 也无效/);
  });

  it('404 提示检查接口地址与模型标识', async () => {
    const p = provider({ providerId: 'kimi', status: 404, body: { error: { message: 'not found' } } });
    const error = await p.complete({ task: 'generate', system: 's', user: 'u' }).catch((e: Error) => e.message);
    expect(error).toContain('Kimi');
    expect(error).toMatch(/接口地址/);
    expect(error).toMatch(/模型标识/);
  });

  it('429 与 5xx 给出各自的处置建议', async () => {
    const rate = provider({ providerId: 'zhipu', status: 429, body: { error: { message: 'rate limit' } } });
    expect(await rate.complete({ task: 'generate', system: 's', user: 'u' }).catch((e: Error) => e.message)).toMatch(/频率|额度/);

    const down = provider({ providerId: 'deepseek', status: 503, body: { error: { message: 'busy' } } });
    expect(await down.complete({ task: 'generate', system: 's', user: 'u' }).catch((e: Error) => e.message)).toMatch(/服务端异常/);
  });

  it('返回非 JSON 错误体时也不抛解析异常', async () => {
    const p = new DeepSeekProvider({
      apiKey: 'sk-test',
      model: 'gpt-5.5',
      providerId: 'openai',
      fetchImpl: (async () =>
        new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        })) as (input: string, init?: RequestInit) => Promise<Response>,
    });
    const error = await p.complete({ task: 'generate', system: 's', user: 'u' }).catch((e: Error) => e.message);
    expect(error).toContain('OpenAI');
    expect(error).toMatch(/服务端异常/);
  });

  it('拉取模型列表时也走同一套翻译（同样会出现地域封锁）', async () => {
    const p = new DeepSeekProvider({
      apiKey: 'sk-test',
      model: 'gpt-5.5',
      providerId: 'openai',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: 'Country, region, or territory not supported' } }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        })) as (input: string, init?: RequestInit) => Promise<Response>,
    });
    const error = await p.listModels().catch((e: Error) => e.message);
    expect(error).toContain('OpenAI');
    expect(error).toMatch(/地区/);
  });

  it('未配置 Key 时提示带上供应商名', async () => {
    const p = new DeepSeekProvider({ apiKey: '', model: 'gpt-5.5', providerId: 'openai' });
    expect(await p.complete({ task: 'generate', system: 's', user: 'u' }).catch((e: Error) => e.message)).toContain('OpenAI');
    expect(await p.listModels().catch((e: Error) => e.message)).toContain('OpenAI');
  });

  it('截断提示用当前供应商名而不是写死的 DeepSeek', async () => {
    const p = new DeepSeekProvider({
      apiKey: 'sk-test',
      model: 'kimi-k3',
      providerId: 'kimi',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '', reasoning_content: '思考'.repeat(50) }, finish_reason: 'length' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )) as (input: string, init?: RequestInit) => Promise<Response>,
    });
    const error = await p.complete({ task: 'generate', system: 's', user: 'u' }).catch((e: Error) => e.message);
    expect(error).toContain('Kimi');
    expect(error).not.toContain('DeepSeek');
  });
});