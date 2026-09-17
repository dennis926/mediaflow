/**
 * 运行时配置（可配置化中心）。
 *
 * 目标：把"换一家公司/换一个行业就能上线"需要改的东西全部放进配置，
 * 而不是散落在代码里。取值顺序：数据库（后台界面）> .env > 这里的默认值。
 *
 * 用法：
 * - 启动时与每次保存设置后调用 `applyRuntimeConfig(flatSettings)` 刷新快照；
 * - 业务代码同步读 `runtime()`，无需依赖注入，也不会因为测试没注入而炸。
 */

export interface SiteConfig {
  /** 站点名称：侧边栏、登录页、浏览器标题、插件弹窗都用它 */
  name: string;
  tagline: string;
  company: string;
  supportEmail: string;
  /** 列表默认每页条数 */
  pageSize: number;
  /** AI 生成内容的显式标识后缀（法定要求，可改文案但别关） */
  aiDisclosureSuffix: string;
}

export interface KnowledgeRuntimeConfig {
  /** 每次 AI 生成最多注入多少条品牌资料 */
  injectLimit: number;
  chunkSize: number;
  chunkOverlap: number;
  maxChunks: number;
  maxDocumentMb: number;
  ocrEnabled: boolean;
  ocrLanguages: string;
  ocrMaxImages: number;
  ocrPdfMaxPages: number;
  ocrDpi: number;
  ocrTimeoutMs: number;
}

export interface AiRuntimeConfig {
  /** 全局写作规范（系统提示词），换行业主要改这里 */
  systemPrompt: string;
  /** 每个平台的风格指引，key = 平台代码 */
  platformGuidance: Record<string, string>;
  temperature: number;
  /** JSON 任务的默认最大输出 token（推理模型要给足） */
  maxTokens: number;
  /** 计价（元/百万 token），用于统计花费；填 0 表示不统计 */
  priceInputPerMTok: number;
  priceOutputPerMTok: number;
}

/** 按 token 用量与配置单价估算花费（元），保留 6 位小数。 */
export function estimateCost(tokensInput: number, tokensOutput: number): string {
  const { priceInputPerMTok, priceOutputPerMTok } = snapshot.ai;
  if (priceInputPerMTok === 0 && priceOutputPerMTok === 0) return '0';
  const cost = (tokensInput / 1_000_000) * priceInputPerMTok + (tokensOutput / 1_000_000) * priceOutputPerMTok;
  return cost.toFixed(6);
}

export type ComplianceCategory = 'medical_claim' | 'absolute_term' | 'guarantee' | 'endorsement';

export interface ComplianceRule {
  category: ComplianceCategory;
  /** 命中即视为违规的词/短语 */
  terms: string[];
  reason: string;
  suggestion: string;
  /** 扣分权重 */
  penalty: number;
}

export interface PublishRuntimeConfig {
  readBlockMs: number;
  readCount: number;
  claimIdleMs: number;
  maxAttempts: number;
  retryIntervalMs: number;
  workerEnabled: boolean;
}

export interface RuntimeConfig {
  site: SiteConfig;
  knowledge: KnowledgeRuntimeConfig;
  ai: AiRuntimeConfig;
  compliance: ComplianceRule[];
  publish: PublishRuntimeConfig;
}

export const DEFAULT_SITE: SiteConfig = {
  name: 'MediaFlow',
  tagline: '内容分发与矩阵运营',
  company: '',
  supportEmail: '',
  pageSize: 10,
  aiDisclosureSuffix: '（本文由 AI 辅助生成）',
};

export const DEFAULT_KNOWLEDGE_RUNTIME: KnowledgeRuntimeConfig = {
  injectLimit: 5,
  chunkSize: 1200,
  chunkOverlap: 200,
  maxChunks: 40,
  maxDocumentMb: 10,
  ocrEnabled: true,
  ocrLanguages: 'chi_sim+eng',
  ocrMaxImages: 20,
  ocrPdfMaxPages: 10,
  ocrDpi: 200,
  ocrTimeoutMs: 30_000,
};

export const DEFAULT_AI_RUNTIME: AiRuntimeConfig = {
  systemPrompt:
    '你是资深中文新媒体编辑，服务食品与营养健康行业，严格遵守《广告法》与食品宣传合规要求，绝不出现疾病治疗、绝对化、承诺性表述。',
  platformGuidance: {
    wechat_mp: '深度图文，可长文，标题 20 字以内，正文分段清晰，不做营销夸大',
    douyin: '短视频文案，口语化，前 3 秒抓住注意力，正文 100 字以内，结尾 3-5 个话题标签',
    xiaohongshu: '种草笔记，第一人称，emoji 适度，正文 300 字以内，结尾 5 个话题标签',
    wechat_video: '视频号口播稿，简洁口语，200 字以内',
    zhihu: '知乎回答风格，先给结论再论证，专业克制，不使用营销词',
    toutiao: '资讯风格，标题信息量大，正文 300-800 字',
    baijiahao: '图文资讯，结构清晰，小标题分节，300-800 字',
  },
  temperature: 0.7,
  maxTokens: 4096,
  priceInputPerMTok: 0,
  priceOutputPerMTok: 0,
};

export const DEFAULT_COMPLIANCE_RULES: ComplianceRule[] = [
  {
    category: 'medical_claim',
    terms: ['治疗', '治愈', '根治', '痊愈', '疗效', '药用', '处方', '主治', '抗癌', '抗肿瘤', '降血糖', '降血压', '降血脂', '消炎', '杀菌'],
    reason: '食品不得宣称疾病治疗或药理作用',
    suggestion: '改为「有助于/日常营养支持」等非治疗性表述',
    penalty: 25,
  },
  {
    category: 'absolute_term',
    terms: ['最好', '最佳', '最有效', '最强', '最优', '第一', '国家级', '最高级', '顶级', '特效', '包治', '100%有效', '百分百', '永久', '彻底解决'],
    reason: '《广告法》禁止使用绝对化用语',
    suggestion: '删除绝对化描述，改为具体、可验证的事实描述',
    penalty: 10,
  },
  {
    category: 'guarantee',
    terms: ['保证见效', '保证治愈', '无效退款', '立竿见影', '一次见效', '当天见效'],
    reason: '不得对效果作出保证性承诺',
    suggestion: '删除效果承诺，补充个体差异说明',
    penalty: 20,
  },
  {
    category: 'endorsement',
    terms: ['医院推荐', '医生推荐', '专家推荐', '临床验证特效', '药监局认证疗效'],
    reason: '不得利用医疗机构、专家名义作证明',
    suggestion: '删除医疗机构/专家背书表述',
    penalty: 20,
  },
];

export const DEFAULT_PUBLISH_RUNTIME: PublishRuntimeConfig = {
  readBlockMs: 5_000,
  readCount: 5,
  claimIdleMs: 60_000,
  maxAttempts: 3,
  retryIntervalMs: 300_000,
  workerEnabled: true,
};

const snapshot: RuntimeConfig = {
  site: { ...DEFAULT_SITE },
  knowledge: { ...DEFAULT_KNOWLEDGE_RUNTIME },
  ai: { ...DEFAULT_AI_RUNTIME, platformGuidance: { ...DEFAULT_AI_RUNTIME.platformGuidance } },
  compliance: DEFAULT_COMPLIANCE_RULES.map((rule) => ({ ...rule, terms: [...rule.terms] })),
  publish: { ...DEFAULT_PUBLISH_RUNTIME },
};

/** 全局同步读取当前配置（默认值 + 后台覆盖）。 */
export function runtime(): RuntimeConfig {
  return snapshot;
}

function num(raw: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function float(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['true', '1', 'yes', 'on', '是', '启用'].includes(raw.trim().toLowerCase());
}

function text(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  return value ? value : fallback;
}

/** 解析 JSON 配置；坏数据时退回默认值并给出提示（不抛异常，避免后台一处写错就全站挂）。 */
function parseJson<T>(raw: string | undefined, fallback: T, onError?: (message: string) => void): T {
  if (raw === undefined || raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    onError?.('配置不是合法 JSON，已使用默认值');
    return fallback;
  }
}

/**
 * 用扁平化的设置快照刷新运行时配置。传入 undefined 的键表示沿用默认值。
 */
export function applyRuntimeConfig(flat: Record<string, string | undefined>, onError?: (message: string) => void): void {
  snapshot.site = {
    name: text(flat.SITE_NAME, DEFAULT_SITE.name),
    tagline: text(flat.SITE_TAGLINE, DEFAULT_SITE.tagline),
    company: text(flat.COMPANY_NAME, DEFAULT_SITE.company),
    supportEmail: text(flat.SUPPORT_EMAIL, DEFAULT_SITE.supportEmail),
    pageSize: num(flat.UI_PAGE_SIZE, DEFAULT_SITE.pageSize, 5, 100),
    aiDisclosureSuffix: text(flat.AI_DISCLOSURE_SUFFIX, DEFAULT_SITE.aiDisclosureSuffix),
  };

  snapshot.knowledge = {
    injectLimit: num(flat.KB_INJECT_LIMIT, DEFAULT_KNOWLEDGE_RUNTIME.injectLimit, 1, 20),
    chunkSize: num(flat.KB_CHUNK_SIZE, DEFAULT_KNOWLEDGE_RUNTIME.chunkSize, 200, 5000),
    chunkOverlap: num(flat.KB_CHUNK_OVERLAP, DEFAULT_KNOWLEDGE_RUNTIME.chunkOverlap, 0, 2000),
    maxChunks: num(flat.KB_MAX_CHUNKS, DEFAULT_KNOWLEDGE_RUNTIME.maxChunks, 1, 500),
    maxDocumentMb: num(flat.KB_MAX_DOCUMENT_MB, DEFAULT_KNOWLEDGE_RUNTIME.maxDocumentMb, 1, 100),
    ocrEnabled: bool(flat.KB_OCR_ENABLED, DEFAULT_KNOWLEDGE_RUNTIME.ocrEnabled),
    ocrLanguages: text(flat.KB_OCR_LANGUAGES, DEFAULT_KNOWLEDGE_RUNTIME.ocrLanguages),
    ocrMaxImages: num(flat.KB_OCR_MAX_IMAGES, DEFAULT_KNOWLEDGE_RUNTIME.ocrMaxImages, 1, 200),
    ocrPdfMaxPages: num(flat.KB_OCR_PDF_MAX_PAGES, DEFAULT_KNOWLEDGE_RUNTIME.ocrPdfMaxPages, 1, 100),
    ocrDpi: num(flat.KB_OCR_DPI, DEFAULT_KNOWLEDGE_RUNTIME.ocrDpi, 72, 600),
    ocrTimeoutMs: num(flat.KB_OCR_TIMEOUT_MS, DEFAULT_KNOWLEDGE_RUNTIME.ocrTimeoutMs, 5000, 300_000),
  };

  snapshot.ai = {
    systemPrompt: text(flat.AI_SYSTEM_PROMPT, DEFAULT_AI_RUNTIME.systemPrompt),
    platformGuidance: parseJson<Record<string, string>>(flat.AI_PLATFORM_GUIDANCE, DEFAULT_AI_RUNTIME.platformGuidance, onError),
    temperature: float(flat.AI_TEMPERATURE, DEFAULT_AI_RUNTIME.temperature, 0, 2),
    maxTokens: num(flat.AI_MAX_TOKENS, DEFAULT_AI_RUNTIME.maxTokens, 256, 32_000),
    priceInputPerMTok: float(flat.AI_PRICE_INPUT_PER_MTOK, DEFAULT_AI_RUNTIME.priceInputPerMTok, 0, 10_000),
    priceOutputPerMTok: float(flat.AI_PRICE_OUTPUT_PER_MTOK, DEFAULT_AI_RUNTIME.priceOutputPerMTok, 0, 10_000),
  };

  const parsedRules = parseJson<ComplianceRule[]>(flat.COMPLIANCE_RULES, DEFAULT_COMPLIANCE_RULES, onError);
  snapshot.compliance =
    Array.isArray(parsedRules) && parsedRules.length > 0
      ? parsedRules
          .filter((rule) => rule && Array.isArray(rule.terms) && rule.terms.length > 0)
          .map((rule) => ({
            category: rule.category ?? 'absolute_term',
            terms: rule.terms.map((term) => String(term)).filter(Boolean),
            reason: rule.reason ?? '命中违规词',
            suggestion: rule.suggestion ?? '请改写为合规表述',
            penalty: Number.isFinite(rule.penalty) ? Number(rule.penalty) : 10,
          }))
      : DEFAULT_COMPLIANCE_RULES.map((rule) => ({ ...rule, terms: [...rule.terms] }));
  if (snapshot.compliance.length === 0) {
    snapshot.compliance = DEFAULT_COMPLIANCE_RULES.map((rule) => ({ ...rule, terms: [...rule.terms] }));
  }

  snapshot.publish = {
    readBlockMs: num(flat.PUBLISH_READ_BLOCK_MS, DEFAULT_PUBLISH_RUNTIME.readBlockMs, 200, 60_000),
    readCount: num(flat.PUBLISH_READ_COUNT, DEFAULT_PUBLISH_RUNTIME.readCount, 1, 100),
    claimIdleMs: num(flat.PUBLISH_CLAIM_IDLE_MS, DEFAULT_PUBLISH_RUNTIME.claimIdleMs, 5_000, 3_600_000),
    maxAttempts: num(flat.PUBLISH_MAX_ATTEMPTS, DEFAULT_PUBLISH_RUNTIME.maxAttempts, 1, 10),
    retryIntervalMs: num(flat.PUBLISH_RETRY_INTERVAL_MS, DEFAULT_PUBLISH_RUNTIME.retryIntervalMs, 1000, 86_400_000),
    workerEnabled: bool(flat.PUBLISH_WORKER_ENABLED, DEFAULT_PUBLISH_RUNTIME.workerEnabled),
  };
}

/** 设置页用的默认值快照（导出配置、生成文档时用）。 */
export function defaultConfigSnapshot(): RuntimeConfig {
  return {
    site: { ...DEFAULT_SITE },
    knowledge: { ...DEFAULT_KNOWLEDGE_RUNTIME },
    ai: { ...DEFAULT_AI_RUNTIME, platformGuidance: { ...DEFAULT_AI_RUNTIME.platformGuidance } },
    compliance: DEFAULT_COMPLIANCE_RULES.map((rule) => ({ ...rule, terms: [...rule.terms] })),
    publish: { ...DEFAULT_PUBLISH_RUNTIME },
  };
}
