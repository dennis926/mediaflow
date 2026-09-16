import { AiCompletionRequest, AiCompletionResult, AiProvider } from '../ai.types';

/**
 * Deterministic offline provider used by tests and by local runs without an API key.
 * It never fabricates a real model answer: outputs follow simple templates so the
 * surrounding pipeline (validation, persistence, logging) can be exercised for real.
 */
export class MockAiProvider implements AiProvider {
  readonly name = 'mock';

  constructor(readonly model = 'mock-model') {}

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const text = this.build(request);
    return { text, model: this.model, tokensInput: request.user.length, tokensOutput: text.length };
  }

  private build(request: AiCompletionRequest): string {
    switch (request.task) {
      case 'adapt':
        return JSON.stringify({ variants: this.buildVariants(request.user) });
      case 'optimize_title':
        return JSON.stringify({ titles: this.buildTitles(request.user) });
      case 'compliance_check':
        return JSON.stringify({ review: '（离线模式）未发现需要额外说明的表述风险。' });
      default:
        return `（离线生成）${request.user.slice(0, 120)}`;
    }
  }

  private buildVariants(user: string): Array<{ platform: string; title: string; body: string; tags: string[] }> {
    const platforms = user.match(/platforms=([a-z_,]+)/)?.[1]?.split(',').filter(Boolean) ?? ['wechat_mp'];
    const title = user.match(/title=([^\n]+)/)?.[1] ?? '未命名内容';
    const body = user.match(/body=([\s\S]*?)\n(?:tags=|$)/)?.[1]?.trim() ?? '正文';
    return platforms.map((platform) => ({
      platform,
      title: `【${platform}】${title}`.slice(0, 60),
      body: `${body}\n\n（本段为 ${platform} 平台适配版本，离线模式生成）`,
      tags: platform === 'xiaohongshu' ? ['健康生活', '日常分享'] : ['健康', '科普'],
    }));
  }

  private buildTitles(user: string): string[] {
    const base = user.match(/title=([^\n]+)/)?.[1] ?? '内容标题';
    return [`${base}｜3 个要点讲清楚`, `关于${base}，先看这一篇`, `${base}：常见疑问一次说明白`];
  }
}
