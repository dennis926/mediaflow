import { describe, expect, it } from 'vitest';
import {
  parseAnthropicPricing,
  parseGooglePricing,
  parseMoonshotPricing,
  parseQwenPricing,
  parseVolcenginePricing,
  parseXaiPricing,
  parseZhipuPricing,
  SCRAPERS,
  findScraper,
  isChallengePage,
} from '../pricing/scrapers';
import { extractMarkdownTables, extractTables, parsePriceCell } from '../pricing/parse-utils';

/**
 * Fixtures are trimmed copies of the live pages, kept verbatim in *structure*
 * (including each vendor's quirks) because those quirks are exactly what a naive
 * parser gets wrong. Every expected number was cross-checked against the value the
 * vendor's own page shows.
 */

const DEEPSEEK_FOR_CHALLENGE = `
<table>
  <tr><th>模型</th><th>deepseek-flash(1)</th></tr>
  <tr><td>价格(2)</td><td colspan="1">百万tokens输入（缓存命中）</td></tr>
  <tr><td>空闲时段</td><td>0.02元</td></tr>
  <tr><td>高峰时段</td><td>0.04元</td></tr>
  <tr><td colspan="2">百万tokens输入（缓存未命中）</td></tr>
  <tr><td>空闲时段</td><td>1元</td></tr>
  <tr><td>高峰时段</td><td>2元</td></tr>
  <tr><td colspan="2">百万tokens输出</td></tr>
  <tr><td>空闲时段</td><td>4元</td></tr>
  <tr><td>高峰时段</td><td>8元</td></tr>
</table>
`;

const ZHIPU_MARKDOWN = `
## 旗舰模型

| 模型名称 | 上下文 | 输入单价（元/百万 Tokens） | 输出单价（元/百万 Tokens） | 缓存存储（元/百万 Tokens/小时） | 缓存命中（元/百万 Tokens） | 输入模态 |
| - | - | - | - | - | - | - |
| GLM-5.3 | 1M | 8 | 28 | 限时免费 | 2 | 文本 |
| GLM-5.3-Flash | 1M | 0.8 | 2.8 | 限时免费 | 0.23 | 图片、视频、文件、文本 |
| GLM-5.3-FlashX | 1M | 2 | 7 | 限时免费 | 0.57 | 图片、视频、文件、文本 |

<Accordion title="更多文本模型">
  | 模型名称 | 上下文 | 输入单价（元/百万 Tokens） | 输出单价（元/百万 Tokens） | 缓存存储（元/百万 Tokens/小时） | 缓存命中（元/百万 Tokens） |
  | - | - | - | - | - | - |
  | GLM-4.7-Flash | 200K | 免费 | 免费 | 限时免费 | 免费 |
  | GLM-4-Plus | 128K | 5 | 5 | 限时免费 | 2.5 |
  | GLM-Image | | 0.5 | 1 | 限时免费 | 0 |
  | GLM-TTS | | 1 | 2 | 限时免费 | 0 |
</Accordion>
`;

const MOONSHOT_MARKDOWN = `
## 模型定价

### K3 系列模型

<DocTable
  columns={[
{ title: "模型", width: "12%" },
{ title: "计费单位", width: "10%" },
{ title: "缓存写入（TTL 5min）", width: "13%" },
{ title: "缓存写入（TTL 1h）", width: "13%" },
{ title: "输入价格（缓存命中）", width: "13%" },
{ title: "输入价格（缓存未命中）", width: "13%" },
{ title: "输出价格", width: "10%" },
{ title: "上下文窗口", width: "16%" },
]}
  rows={[
["kimi-k3", "1M tokens", "¥20.00", "¥40.00", "¥2.00", "¥20.00", "¥100.00", "1,048,576 tokens"],
]}
/>

### K2 系列模型

<DocTable
  columns={[
{ title: "模型", width: "24%" },
{ title: "计费单位", width: "12%" },
{ title: "输入价格（缓存命中）", width: "16%" },
{ title: "输入价格（缓存未命中）", width: "16%" },
{ title: "输出价格", width: "14%" },
{ title: "上下文窗口", width: "18%" },
]}
  rows={[
["kimi-k2.6", "1M tokens", "¥1.10", "¥6.50", "¥27.00", "262,144 tokens"],
]}
/>
`;

const XAI_MARKDOWN = `
### Text API Pricing

| Model | Context | Input / 1M tokens | Cached input / 1M tokens | Output / 1M tokens |
| --- | --- | --- | --- | --- |
| grok-4.7 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |
| grok-4.7 (≥ 200k prompt tokens) | 500k | $4.00 | $1.00 | $12.00 |
| grok-4.3 (< 200k prompt tokens) | 1M | $1.25 | $0.20 | $2.50 |

### Imagine Pricing

| Model | Cost |
| --- | --- |
| grok-imagine-image-2.0 | $0.04 / image |
`;

const ANTHROPIC_HTML = `
<div class="modelCard"><div class="modelTitle"><h3 class="__modelName text-headline-4-serif">Fable 5.1</h3>
<p class="subtitle">Next generation intelligence</p></div><div class="modelBody">
<div class="priceBlock"><div class="priceRow"><p class="__priceLabel text-body-2">Prompt caching</p></div>
<div class="priceBreakdown">
<div class="priceRow"><p class="__priceLabel __priceLabelSub">Read</p><p class="__priceValue">$0.25<!-- --> <!-- -->/ MTok</p></div>
<div class="priceRow"><p class="__priceLabel __priceLabelSub">Write</p><p class="__priceValue">$12.50<!-- --> <!-- -->/ MTok</p></div>
</div></div>
<div class="priceBlock"><div class="priceRow"><p class="__priceLabel text-body-2">Input</p><p class="__priceValue">$10<!-- --> <!-- -->/ MTok</p></div></div>
<div class="priceBlock"><div class="priceRow"><p class="__priceLabel text-body-2">Output</p><p class="__priceValue">$50<!-- --> <!-- -->/ MTok</p></div></div>
</div></div>
<div class="modelCard"><div class="modelTitle"><h3 class="__modelName text-headline-4-serif">Opus 5.5</h3>
<p class="subtitle">Daily driver</p></div><div class="modelBody">
<div class="priceBlock"><div class="priceRow"><p class="__priceLabel text-body-2">Prompt caching</p></div>
<div class="priceBreakdown">
<div class="priceRow"><p class="__priceLabel __priceLabelSub">Read</p><p class="__priceValue">$0.20<!-- --> <!-- -->/ MTok</p></div>
<div class="priceRow"><p class="__priceLabel __priceLabelSub">Write</p><p class="__priceValue">$5<!-- --> <!-- -->/ MTok</p></div>
</div></div>
<div class="priceBlock"><div class="priceRow"><p class="__priceLabel text-body-2">Input</p><p class="__priceValue">$4<!-- --> <!-- -->/ MTok</p></div></div>
<div class="priceBlock"><div class="priceRow"><p class="__priceLabel text-body-2">Output</p><p class="__priceValue">$20<!-- --> <!-- -->/ MTok</p></div></div>
</div></div>
<div class="modelCard"><div class="modelTitle"><h3 class="__modelName">Some Unmapped Model</h3></div>
<div class="modelBody"><div class="priceBlock"><div class="priceRow"><p class="__priceLabel">Input</p><p class="__priceValue">$99</p></div></div></div></div>
`;

/**
 * Trimmed copy of the *standard* Vertex table (the first one on the page).
 * Note the shape: "Gemini 3.8 Flash" appears twice — once with a promotional
 * "* through December 31, 2026" suffix and once as the post-2027 rate — and each
 * model's input and output sit in separate rows, so the parser must accumulate.
 */
const GOOGLE_HTML = `
<table>
  <tr><th>Model</th><th>Type</th><th>Region</th><th>Price (/1M tokens)&lt;= 200K input tokens</th><th>Price (/1M tokens)&gt; 200K input tokens</th><th>Price (/1M tokens)&lt;= 200K cached input tokens</th><th>Price (/1M tokens)&gt; 200K cached input tokens</th></tr>
  <tr><td>Gemini 3.8 Flash Cyber</td><td>Input (text, image, video, audio)</td><td>Global</td><td>$1.50</td><td>$1.50</td><td>$0.15</td><td>$0.15</td></tr>
  <tr><td></td><td>Text output (response and reasoning)</td><td>Global</td><td>$7.50</td><td>$7.50</td><td>N/A</td><td>N/A</td></tr>
  <tr><td>Gemini 3.8 Flash* through December 31, 2026</td><td>Input (text, image, video, audio)</td><td>Global</td><td>$0.75</td><td>$0.75</td><td>$0.075</td><td>$0.075</td></tr>
  <tr><td></td><td>Text output (response and reasoning)</td><td>Global</td><td>$3.75</td><td>$3.75</td><td>N/A</td><td>N/A</td></tr>
  <tr><td>Gemini 3.1 Pro Preview</td><td>Input (text, image, video, audio)</td><td>Global</td><td>$2.00</td><td>$4.00</td><td>$0.20</td><td>$0.40</td></tr>
  <tr><td></td><td>Text output (response and reasoning)</td><td>Global</td><td>$12.00</td><td>$18.00</td><td>N/A</td><td>N/A</td></tr>
  <tr><td>Gemini 3.8 Flash* through December 31, 2026</td><td>Input (text, image, video, audio)</td><td>Non-global</td><td>$0.825</td><td>$0.825</td><td>$0.0825</td><td>$0.0825</td></tr>
  <tr><td>Gemini 3 Pro Image (Nano Banana Pro)</td><td>Input</td><td>Global</td><td>$2.00</td><td>N/A</td><td>N/A</td><td>N/A</td></tr>
  <tr><td></td><td>Image Output****</td><td>Global</td><td>$30.00</td><td>N/A</td><td>N/A</td><td>N/A</td></tr>
</table>
<table>
  <tr><th>Model</th><th>Type</th><th>Region</th><th>Price (/1M tokens)&lt;= 200K input tokens with Priority</th></tr>
  <tr><td>Gemini 3.1 Pro Preview</td><td>Input</td><td>Global</td><td>$3.60</td></tr>
</table>
<table>
  <tr><th>Model</th><th>Type</th><th>Region</th><th>Price (/1M tokens)&lt;= 200K input tokens</th></tr>
  <tr><td>Gemini 3 Pro Image (Nano Banana Pro)</td><td>Input</td><td>Global</td><td>$999.00</td></tr>
</table>
`;

const VOLCENGINE_HTML = `
<table>
  <tr><td>模型名称</td><td>条件输入长度：千 token</td><td>输入(非音频)元/百万token</td><td>输入(音频)元/百万token</td><td>缓存存储元/百万token/小时</td><td>缓存命中(非音频)元/百万token</td><td>缓存命中(音频)元/百万token</td><td>输出元/百万token</td></tr>
  <tr><td>doubao-seed-evolving</td><td>输入长度 [0, 1024]</td><td>6.00</td><td>-</td><td>0.017</td><td>1.20</td><td>-</td><td>30.00</td></tr>
  <tr><td>doubao-seed-2.1-lite</td><td>输入长度 [0, 1024]</td><td>0.80</td><td>12.00</td><td>0.017</td><td>0.16</td><td>2.40</td><td>2.70</td></tr>
  <tr><td>doubao-seedream-5.0</td><td>按张计费</td><td>0.20</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>
</table>
`;

/**
 * Trimmed copy of Aliyun's billing page. Two traps are reproduced faithfully:
 *  - tables are JSX (`<td style={{...}}>`), not HTML;
 *  - the model cell uses rowSpan across context tiers, and each model repeats in
 *    per-region <Tab> panes with *different* prices (Singapore above Beijing).
 */
const QWEN_MARKDOWN = `
<Tabs>
  <Tab title="华北2（北京）">
    <table style={{ display: "table" }}>
      <thead>
        <tr>
          <th style={{ verticalAlign: "top" }}><strong>模型 ID（Model ID）</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>模式</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>单次请求的输入Token数</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>输入单价（每百万Token）</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>输出单价（每百万Token）</strong></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen3.8-max

            > 更多详情参考[优速模式（Prime）](/zh/model-studio/prime-mode)
          </td>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>非思考和思考模式</td>
          <td style={{ verticalAlign: "top" }}>0\\<Token≤128K</td>
          <td style={{ verticalAlign: "top" }}>12元</td>
          <td style={{ verticalAlign: "top" }}>36元</td>
        </tr>
        <tr>
          <td style={{ verticalAlign: "top" }}>128K\\<Token≤1M</td>
          <td style={{ verticalAlign: "top" }}>24元</td>
          <td style={{ verticalAlign: "top" }}>72元</td>
        </tr>
        <tr>
          <td style={{ verticalAlign: "top" }}>qwen-audio-3.1-tts-next</td>
          <td style={{ verticalAlign: "top" }}>非流式</td>
          <td style={{ verticalAlign: "top" }}>0\\<Token≤128K</td>
          <td style={{ verticalAlign: "top" }}>6元</td>
          <td style={{ verticalAlign: "top" }}>12元</td>
        </tr>
        <tr>
          <td style={{ verticalAlign: "top" }}>deepseek-v4.1-flash</td>
          <td style={{ verticalAlign: "top" }}>非思考</td>
          <td style={{ verticalAlign: "top" }}>0\\<Token≤128K</td>
          <td style={{ verticalAlign: "top" }}>1元</td>
          <td style={{ verticalAlign: "top" }}>4元</td>
        </tr>
      </tbody>
    </table>
  </Tab>
  <Tab title="新加坡">
    <table style={{ display: "table" }}>
      <thead>
        <tr>
          <th><strong>模型 ID（Model ID）</strong></th>
          <th><strong>输入单价（每百万Token）</strong></th>
          <th><strong>输出单价（每百万Token）</strong></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style={{ verticalAlign: "top" }}>qwen3.8-max</td>
          <td style={{ verticalAlign: "top" }}>14.988元</td>
          <td style={{ verticalAlign: "top" }}>44.965元</td>
        </tr>
      </tbody>
    </table>
  </Tab>
</Tabs>
`;

describe('智谱官方价解析', () => {
  it('读出人民币单价与缓存命中价', () => {
    const prices = parseZhipuPricing(ZHIPU_MARKDOWN);
    const glm53 = prices.find((price) => price.model === 'GLM-5.3');
    expect(glm53?.peak).toMatchObject({ input: 8, output: 28, cacheRead: 2 });
    expect(glm53?.currency).toBe('CNY');
  });

  it('读得出 Accordion 里缩进的表格', () => {
    const prices = parseZhipuPricing(ZHIPU_MARKDOWN);
    expect(prices.find((price) => price.model === 'GLM-4-Plus')?.peak.input).toBe(5);
  });

  it('"免费"识别为 0 而不是被丢弃', () => {
    const free = parseZhipuPricing(ZHIPU_MARKDOWN).find((price) => price.model === 'GLM-4.7-Flash');
    expect(free).toBeDefined();
    expect(free?.peak.input).toBe(0);
  });

  it('跳过按次计费的图像/语音模型', () => {
    const names = parseZhipuPricing(ZHIPU_MARKDOWN).map((price) => price.model);
    expect(names).not.toContain('GLM-Image');
    expect(names).not.toContain('GLM-TTS');
  });
});

describe('Kimi 官方价解析', () => {
  it('按列标题对齐取值（缓存写入 / 命中 / 未命中 / 输出）', () => {
    const k3 = parseMoonshotPricing(MOONSHOT_MARKDOWN).find((price) => price.model === 'kimi-k3');
    // 未命中输入 ¥20、命中 ¥2、输出 ¥100、5min 缓存写入 ¥20
    expect(k3?.peak).toMatchObject({ input: 20, output: 100, cacheRead: 2, cacheWrite: 20 });
    expect(k3?.currency).toBe('CNY');
  });

  it('K2 系列（列较少）也能正确对齐，不会错位', () => {
    const k26 = parseMoonshotPricing(MOONSHOT_MARKDOWN).find((price) => price.model === 'kimi-k2.6');
    expect(k26?.peak).toMatchObject({ input: 6.5, output: 27, cacheRead: 1.1 });
  });
});

describe('xAI 官方价解析', () => {
  it('读美元价，并把长上下文变体排除在外', () => {
    const prices = parseXaiPricing(XAI_MARKDOWN);
    expect(prices.filter((price) => price.model === 'grok-4.7')).toHaveLength(1);
    const grok = prices.find((price) => price.model === 'grok-4.7');
    expect(grok?.peak).toMatchObject({ input: 2, output: 6, cacheRead: 0.5 });
    expect(grok?.currency).toBe('USD');
  });

  it('图像/视频模型不进 token 价目表', () => {
    const names = parseXaiPricing(XAI_MARKDOWN).map((price) => price.model);
    expect(names.some((name) => /imagine/.test(name))).toBe(false);
  });
});

describe('Anthropic 官方价解析', () => {
  it('读出 Input/Output 与缓存读写，并映射到 API 模型 id', () => {
    const fable = parseAnthropicPricing(ANTHROPIC_HTML).find((price) => price.model === 'claude-fable-5-1');
    expect(fable?.peak).toMatchObject({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
    expect(fable?.currency).toBe('USD');
  });

  it('缓存 Read/Write 不会被当成 Input/Output', () => {
    const opus = parseAnthropicPricing(ANTHROPIC_HTML).find((price) => price.model === 'claude-opus-5-5');
    expect(opus?.peak.input).toBe(4);
    expect(opus?.peak.output).toBe(20);
  });

  it('映射表里没有的模型被跳过，而不是用错误的模型名入库', () => {
    const names = parseAnthropicPricing(ANTHROPIC_HTML).map((price) => price.model);
    expect(names).not.toContain('Some Unmapped Model');
  });
});

describe('Google Vertex 官方价解析', () => {
  it('只读标准档（跳过 Priority/Batch）与 Global 区域', () => {
    const flash = parseGooglePricing(GOOGLE_HTML).find((price) => price.model === 'gemini-3.8-flash');
    expect(flash?.peak.input).toBe(0.75);
    expect(flash?.peak.output).toBe(3.75);
    expect(flash?.peak.cacheRead).toBe(0.075);
    expect(flash?.currency).toBe('USD');
  });

  it('输入/输出分行的模型能合并成一条', () => {
    const pro = parseGooglePricing(GOOGLE_HTML).find((price) => price.model === 'gemini-3.1-pro-preview');
    expect(pro?.peak.input).toBe(2);
    expect(pro?.peak.output).toBe(12);
  });

  it('促销行与正式行合并到同一个模型名，不会重名也不会互相覆盖', () => {
    const names = parseGooglePricing(GOOGLE_HTML).map((price) => price.model);
    expect(new Set(names).size).toBe(names.length);
    // 促销档先出现，取第一个值（当前生效价）
    expect(names.filter((name) => name === 'gemini-3.8-flash')).toHaveLength(1);
  });

  it('图像/视频模型不进 token 价目表，后续重复表也不会覆盖文本价', () => {
    const prices = parseGooglePricing(GOOGLE_HTML);
    expect(prices.some((price) => /image|banana/i.test(price.model))).toBe(false);
    expect(prices.find((price) => price.model === 'gemini-3.1-pro-preview')?.peak.input).toBe(2);
  });

  it('页面结构变化时返回空数组而不是猜价格', () => {
    expect(parseGooglePricing('<table><tr><td>改版了</td></tr></table>')).toEqual([]);
  });
});

describe('火山引擎（豆包）官方价解析', () => {
  it('读出人民币输入/输出/缓存命中价', () => {
    const evolving = parseVolcenginePricing(VOLCENGINE_HTML).find(
      (price) => price.model === 'doubao-seed-evolving',
    );
    expect(evolving?.peak).toMatchObject({ input: 6, output: 30, cacheRead: 1.2 });
    expect(evolving?.currency).toBe('CNY');
  });

  it('非 doubao 前缀的模型（图像等）不进价目表', () => {
    const names = parseVolcenginePricing(VOLCENGINE_HTML).map((price) => price.model);
    expect(names.some((name) => /seedream/.test(name))).toBe(false);
  });
});

describe('阿里云百炼（千问）官方价解析', () => {
  it('解析 JSX 表格（不是 HTML、不是 markdown）', () => {
    const qwen = parseQwenPricing(QWEN_MARKDOWN).find((price) => price.model === 'qwen3.8-max');
    expect(qwen).toBeDefined();
    expect(qwen?.currency).toBe('CNY');
  });

  it('rowSpan 展开正确：取第一档阶梯价，而不是错位读到后一档', () => {
    // 模型单元格 rowSpan=2 跨两档；若不展开，第二档的 24/72 会顶到模型名位置上
    const qwen = parseQwenPricing(QWEN_MARKDOWN).find((price) => price.model === 'qwen3.8-max');
    expect(qwen?.peak.input).toBe(12);
    expect(qwen?.peak.output).toBe(36);
  });

  it('模型名只取第一个词元，不把"> 更多详情参考…"混进模型名', () => {
    const names = parseQwenPricing(QWEN_MARKDOWN).map((price) => price.model);
    expect(names).toContain('qwen3.8-max');
    expect(names.some((name) => /更多详情/.test(name))).toBe(false);
  });

  it('只取北京地区价，不取新加坡等地区的加价', () => {
    const qwen = parseQwenPricing(QWEN_MARKDOWN).find((price) => price.model === 'qwen3.8-max');
    expect(qwen?.peak.input).toBe(12); // 新加坡是 14.988
  });

  it('平台上转售的第三方模型不进千问价目表', () => {
    const names = parseQwenPricing(QWEN_MARKDOWN).map((price) => price.model);
    expect(names.some((name) => /deepseek/i.test(name))).toBe(false);
  });

  it('按次/按音频计费的模型不进 token 价目表', () => {
    const names = parseQwenPricing(QWEN_MARKDOWN).map((price) => price.model);
    expect(names).not.toContain('qwen-audio-3.1-tts-next');
  });
});

describe('人机校验页识别', () => {
  it('识别 SHA-256 工作量证明页（HTTP 200 但不是真页面）', () => {
    expect(isChallengePage('<script>function SHA256() {this._buf = new Array(64);}</script>')).toBe(true);
  });

  it('识别 JS 空壳页：含版本号但没有任何表格', () => {
    // volcengine 的实际挑战页带 "1.0.0.1016" 这类版本号，天真地查"有没有数字"会漏判
    const shell = '<html><body><script>window.gfdatav1={"ver":"1.0.0.1016","env":"prod"};</script><div id="app"></div></body></html>';
    expect(isChallengePage(shell)).toBe(true);
  });

  it('真实价格页不会被误判', () => {
    expect(isChallengePage(GOOGLE_HTML)).toBe(false);
    expect(isChallengePage(DEEPSEEK_FOR_CHALLENGE)).toBe(false);
  });
});

describe('抓取器注册表', () => {
  it('每个注册的抓取器都有页面地址与解析函数', () => {
    expect(SCRAPERS.length).toBeGreaterThanOrEqual(8);
    for (const scraper of SCRAPERS) {
      expect(scraper.url).toMatch(/^https:\/\//);
      expect(typeof scraper.parse).toBe('function');
    }
  });

  it('供应商名不重复', () => {
    const providers = SCRAPERS.map((scraper) => scraper.provider);
    expect(new Set(providers).size).toBe(providers.length);
  });

  it('findScraper 找得到已注册的、找不到未注册的', () => {
    expect(findScraper('deepseek')?.provider).toBe('deepseek');
    expect(findScraper('openai')).toBeUndefined();
  });
});

describe('通用解析工具', () => {
  it('parsePriceCell 把"免费"识别成 0、"N/A"识别成 null', () => {
    expect(parsePriceCell('免费')).toBe(0);
    expect(parsePriceCell('Free')).toBe(0);
    expect(parsePriceCell('N/A')).toBeNull();
    expect(parsePriceCell('不支持')).toBeNull();
    expect(parsePriceCell('￥12.50')).toBe(12.5);
    expect(parsePriceCell('1,200')).toBe(1200);
  });

  it('markdown 表格解析跳过 |---| 分隔行', () => {
    const tables = extractMarkdownTables('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(tables[0].rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('HTML 表格解析能剥离 script/style 与零宽字符', () => {
    const tables = extractTables('<table><tr><td><style>x{}</style>6.00\u200b</td></tr></table>');
    expect(tables[0].rows[0][0]).toBe('6.00');
  });
});
