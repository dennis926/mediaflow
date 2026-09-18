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
    return { text, model: this.model, tokensInput: request.user.length, tokensOutput: text.length, tokensCached: 0, tokensReasoning: 0 };
  }

  private build(request: AiCompletionRequest): string {
    switch (request.task) {
      case 'adapt':
        return JSON.stringify({ variants: this.buildVariants(request.user) });
      case 'optimize_title':
        return JSON.stringify({ titles: this.buildTitles(request.user) });
      case 'knowledge_generate':
        return JSON.stringify(this.buildKnowledgeDraft(request.user));
      case 'knowledge_polish':
        return JSON.stringify({ content: this.buildPolished(request.user) });
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

  private buildKnowledgeDraft(user: string): { title: string; content: string; tags: string[]; keywords: string[] } {
    const pick = (key: string): string => user.match(new RegExp(`${key}=([^\\n]+)`))?.[1] ?? '';
    const brand = pick('brand') || '本品牌';
    const points = this.extractBlock(user, 'points');
    const firstPoint = points.split('\n').map((line) => line.trim()).find(Boolean) ?? '待补充要点';
    const tags = points
      .split(/[\n，,、]/)
      .map((line) => line.trim())
      .filter((line) => line.length >= 2 && line.length <= 8)
      .slice(0, 4);
    return {
      title: `（离线占位）${brand}·${firstPoint}`.slice(0, 60),
      content: [
        '（离线占位内容）当前未配置真实 AI Key，这一段是按模板拼出的占位文本，仅用于打通流程。',
        `要点原文：${points}`,
        '配置「设置 → AI」里的 Key 后，这里会变成模型生成的结构化条目。',
      ].join('\n'),
      tags: tags.length > 0 ? tags : ['待补充'],
      keywords: tags,
    };
  }

  /** 取 `key=` 之后的内容，直到遇到下一个指令行（如"以下是…""要求…""输出格式…"）或结束。 */
  private extractBlock(user: string, key: string): string {
    const lines = user.split('\n');
    const start = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (start === -1) return '';
    const collected = [lines[start].slice(key.length + 1)];
    for (const line of lines.slice(start + 1)) {
      if (/^(以下是|要求：|要求|输出格式|content=|instruction=|tone=|brand=|category=|适用平台=)/.test(line.trim())) break;
      collected.push(line);
    }
    return collected.join('\n').trim();
  }

  private buildPolished(user: string): string {
    const content = this.extractBlock(user, 'content');
    return `${content}\n\n（离线占位：未配置真实 AI Key，正文未做实际润色。）`;
  }

  private buildTitles(user: string): string[] {
    const base = user.match(/title=([^\n]+)/)?.[1] ?? '内容标题';
    return [`${base}｜3 个要点讲清楚`, `关于${base}，先看这一篇`, `${base}：常见疑问一次说明白`];
  }
}
