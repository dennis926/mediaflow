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
  /** 品牌主色（十六进制）；界面据此推导整套色阶 */
  brandColor: string;
  /** 侧边栏 Logo 地址，留空则用站点名首字 */
  logoUrl: string;
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
  /** 普通任务的最大输出 token */
  maxTokens: number;
  /** JSON 任务的最大输出 token（推理模型的思考也占额度，给少了 JSON 会缺尾巴） */
  jsonMaxTokens: number;
  /** 计价（元/百万 token），用于统计花费；填 0 表示不统计 */
  priceInputPerMTok: number;
  /** 缓存命中的输入单价（大模型官网按此单独计价，通常远低于未命中价） */
  priceCachedInputPerMTok: number;
  priceOutputPerMTok: number;
  /** 每分钟最多生成次数，0 = 不限 */
  rateLimitPerMinute: number;
  /** 每日 token 上限，0 = 不限 */
  dailyTokenQuota: number;
}

/**
 * 按 token 用量与配置单价估算花费（元），保留 6 位小数。
 *
 * 与主流大模型官网一致的三段计价：
 *   输入（未命中缓存）× 未命中价 + 输入（命中缓存）× 缓存价 + 输出 × 输出价
 * 未单独配置缓存价时退化用未命中价（等价于旧的两段算法）。
 */
export function estimateCost(tokensInput: number, tokensOutput: number, tokensCached = 0): string {
  const { priceInputPerMTok, priceCachedInputPerMTok, priceOutputPerMTok } = snapshot.ai;
  if (priceInputPerMTok === 0 && priceOutputPerMTok === 0 && priceCachedInputPerMTok === 0) return '0';

  const cached = Math.max(0, Math.min(tokensCached, tokensInput));
  const missedInput = Math.max(0, tokensInput - cached);
  const cachedPrice = priceCachedInputPerMTok > 0 ? priceCachedInputPerMTok : priceInputPerMTok;

  const cost =
    (missedInput / 1_000_000) * priceInputPerMTok +
    (cached / 1_000_000) * cachedPrice +
    (tokensOutput / 1_000_000) * priceOutputPerMTok;
  return cost.toFixed(6);
}

/** 计费明细（官网那种"单价 × 用量 = 金额"的展示需要分段金额）。 */
export function costBreakdown(input: { tokensInput: number; tokensOutput: number; tokensCached: number }): {
  inputMissed: { tokens: number; unitPrice: number; amount: string };
  inputCached: { tokens: number; unitPrice: number; amount: string };
  output: { tokens: number; unitPrice: number; amount: string };
  total: string;
} {
  const { priceInputPerMTok, priceCachedInputPerMTok, priceOutputPerMTok } = snapshot.ai;
  const cached = Math.max(0, Math.min(input.tokensCached, input.tokensInput));
  const missed = Math.max(0, input.tokensInput - cached);
  const cachedPrice = priceCachedInputPerMTok > 0 ? priceCachedInputPerMTok : priceInputPerMTok;
  const amount = (tokens: number, price: number): string => ((tokens / 1_000_000) * price).toFixed(6);
  return {
    inputMissed: { tokens: missed, unitPrice: priceInputPerMTok, amount: amount(missed, priceInputPerMTok) },
    inputCached: { tokens: cached, unitPrice: cachedPrice, amount: amount(cached, cachedPrice) },
    output: { tokens: input.tokensOutput, unitPrice: priceOutputPerMTok, amount: amount(input.tokensOutput, priceOutputPerMTok) },
    total: estimateCost(input.tokensInput, input.tokensOutput, input.tokensCached),
  };
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
  /** Redis Stream 名称与消费组名（换环境可用独立队列） */
  streamName: string;
  groupName: string;
  /** 队列 stream 的长度上限（近似修剪）。防止已 ack 的消息无限累积占内存。 */
  maxLen: number;
  /** 站内通知保留天数，0 = 永久保留 */
  notificationRetentionDays: number;
  /** 发布时是否写入 AI 生成标识元数据 */
  aiMetadataEnabled: boolean;
  readBlockMs: number;
  readCount: number;
  claimIdleMs: number;
  maxAttempts: number;
  retryIntervalMs: number;
  workerEnabled: boolean;
  /** 超过这个时间仍未结束的任务视为卡住 */
  stuckMinutes: number;
}

export interface PermissionsRuntimeConfig {
  /** 能力点 → 允许的角色代码（见 auth/capabilities.ts） */
  matrix: Record<string, string[]>;
  /** 角色代码 → 显示名（可按公司习惯改） */
  roleLabels: Record<string, string>;
}

export interface AuthRuntimeConfig {
  /** 访问令牌有效期（如 2h） */
  accessExpires: string;
  /** 刷新令牌有效期（如 7d） */
  refreshExpires: string;
}

export interface MediaRuntimeConfig {
  /** 素材存放目录（相对仓库根或绝对路径，可指向挂载盘/对象存储挂载点） */
  storageDir: string;
  maxFileMb: number;
  /** 允许的 MIME 类型白名单 */
  allowedTypes: string[];
  /** 对外访问前缀；留空则用 /api/public/media/<文件名> */
  publicBaseUrl: string;
  /** 内容版本历史保留条数，0 = 不留历史 */
  contentHistoryLimit: number;
}

export interface NotifyRuntimeConfig {
  /** 推送到外部渠道的最低级别（info = 全部） */
  minLevel: 'info' | 'warning' | 'error';
  webhookUrl: string;
  webhookType: 'auto' | 'dingtalk' | 'feishu' | 'wecom' | 'generic';
  emailEnabled: boolean;
  emailTo: string[];
  smtp: { host: string; port: number; secure: boolean; user: string; password: string; fromName: string };
  onPublishFailure: boolean;
  accountExpiryWarnDays: number;
}

export interface RuntimeConfig {
  site: SiteConfig;
  notify: NotifyRuntimeConfig;
  media: MediaRuntimeConfig;
  auth: AuthRuntimeConfig;
  knowledge: KnowledgeRuntimeConfig;
  ai: AiRuntimeConfig;
  compliance: ComplianceRule[];
  publish: PublishRuntimeConfig;
  permissions: PermissionsRuntimeConfig;
}

export const DEFAULT_SITE: SiteConfig = {
  name: 'MediaFlow',
  tagline: '内容分发与矩阵运营',
  company: '',
  supportEmail: '',
  brandColor: '#4F6BFF',
  logoUrl: '',
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
  jsonMaxTokens: 8192,
  priceInputPerMTok: 0,
  priceCachedInputPerMTok: 0,
  priceOutputPerMTok: 0,
  rateLimitPerMinute: 0,
  dailyTokenQuota: 0,
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
  streamName: 'mediaflow:publish:tasks',
  groupName: 'publish-workers',
  maxLen: 10_000,
  notificationRetentionDays: 90,
  aiMetadataEnabled: true,
  readBlockMs: 5_000,
  readCount: 5,
  claimIdleMs: 60_000,
  maxAttempts: 3,
  retryIntervalMs: 300_000,
  workerEnabled: true,
  stuckMinutes: 15,
};

export const DEFAULT_PERMISSION_MATRIX_RUNTIME: Record<string, string[]> = {
  'settings.write': ['owner', 'admin'],
  'users.manage': ['owner', 'admin'],
  'users.privileged': ['owner'],
  'content.write': ['owner', 'admin', 'editor'],
  'content.review': ['owner', 'admin', 'reviewer'],
  'content.archive': ['owner', 'admin', 'editor'],
  'publish.execute': ['owner', 'admin', 'editor'],
  'knowledge.write': ['owner', 'admin', 'editor'],
  'platform.bind': ['owner', 'admin'],
  'analytics.sync': ['owner', 'admin'],
  'audit.read': ['owner', 'admin'],
  'workspace.manage': ['owner', 'admin'],
};

export const DEFAULT_ROLE_LABELS_RUNTIME: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  editor: '内容编辑',
  reviewer: '审核员',
  viewer: '只读',
};

export const DEFAULT_AUTH_RUNTIME: AuthRuntimeConfig = { accessExpires: '2h', refreshExpires: '7d' };

export const DEFAULT_MEDIA_RUNTIME: MediaRuntimeConfig = {
  storageDir: 'uploads/media',
  maxFileMb: 50,
  allowedTypes: [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'audio/mpeg',
    'audio/wav',
  ],
  publicBaseUrl: '',
  contentHistoryLimit: 20,
};

export const DEFAULT_NOTIFY_RUNTIME: NotifyRuntimeConfig = {
  minLevel: 'warning',
  webhookUrl: '',
  webhookType: 'auto',
  emailEnabled: false,
  emailTo: [],
  smtp: { host: '', port: 465, secure: true, user: '', password: '', fromName: '' },
  onPublishFailure: true,
  accountExpiryWarnDays: 7,
};

const snapshot: RuntimeConfig = {
  site: { ...DEFAULT_SITE },
  auth: { ...DEFAULT_AUTH_RUNTIME },
  media: { ...DEFAULT_MEDIA_RUNTIME },
  notify: { ...DEFAULT_NOTIFY_RUNTIME },
  knowledge: { ...DEFAULT_KNOWLEDGE_RUNTIME },
  ai: { ...DEFAULT_AI_RUNTIME, platformGuidance: { ...DEFAULT_AI_RUNTIME.platformGuidance } },
  compliance: DEFAULT_COMPLIANCE_RULES.map((rule) => ({ ...rule, terms: [...rule.terms] })),
  publish: { ...DEFAULT_PUBLISH_RUNTIME },
  permissions: {
    matrix: { ...DEFAULT_PERMISSION_MATRIX_RUNTIME },
    roleLabels: { ...DEFAULT_ROLE_LABELS_RUNTIME },
  },
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

/** 只接受 3/6 位十六进制颜色，其它一律回退默认（防止脏配置把界面搞成不可读）。 */
function color(raw: string | undefined, fallback: string): string {
  const value = raw?.trim() ?? '';
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value.toUpperCase() : fallback;
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
    brandColor: color(flat.SITE_BRAND_COLOR, DEFAULT_SITE.brandColor),
    logoUrl: text(flat.SITE_LOGO_URL, DEFAULT_SITE.logoUrl),
    pageSize: num(flat.UI_PAGE_SIZE, DEFAULT_SITE.pageSize, 5, 100),
    aiDisclosureSuffix: text(flat.AI_DISCLOSURE_SUFFIX, DEFAULT_SITE.aiDisclosureSuffix),
  };

  snapshot.notify = {
    minLevel: ((): NotifyRuntimeConfig['minLevel'] => {
      const value = (flat.NOTIFY_MIN_LEVEL ?? 'warning').trim();
      return (['info', 'warning', 'error'] as const).includes(value as never) ? (value as NotifyRuntimeConfig['minLevel']) : 'warning';
    })(),
    webhookUrl: text(flat.NOTIFY_WEBHOOK_URL, DEFAULT_NOTIFY_RUNTIME.webhookUrl),
    webhookType: ((): NotifyRuntimeConfig['webhookType'] => {
      const value = (flat.NOTIFY_WEBHOOK_TYPE ?? 'auto').trim();
      return (['auto', 'dingtalk', 'feishu', 'wecom', 'generic'] as const).includes(value as never)
        ? (value as NotifyRuntimeConfig['webhookType'])
        : 'auto';
    })(),
    emailEnabled: bool(flat.NOTIFY_EMAIL_ENABLED, DEFAULT_NOTIFY_RUNTIME.emailEnabled),
    emailTo: (flat.NOTIFY_EMAIL_TO ?? '')
      .split(/[,，;\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
    smtp: {
      host: text(flat.SMTP_HOST, DEFAULT_NOTIFY_RUNTIME.smtp.host),
      port: num(flat.SMTP_PORT, DEFAULT_NOTIFY_RUNTIME.smtp.port, 1, 65535),
      secure: bool(flat.SMTP_SECURE, DEFAULT_NOTIFY_RUNTIME.smtp.secure),
      user: text(flat.SMTP_USER, DEFAULT_NOTIFY_RUNTIME.smtp.user),
      password: text(flat.SMTP_PASSWORD, DEFAULT_NOTIFY_RUNTIME.smtp.password),
      fromName: text(flat.SMTP_FROM, DEFAULT_NOTIFY_RUNTIME.smtp.fromName),
    },
    onPublishFailure: bool(flat.NOTIFY_ON_PUBLISH_FAILURE, DEFAULT_NOTIFY_RUNTIME.onPublishFailure),
    accountExpiryWarnDays: num(flat.ACCOUNT_EXPIRY_WARN_DAYS, DEFAULT_NOTIFY_RUNTIME.accountExpiryWarnDays, 0, 90),
  };

  snapshot.media = {
    storageDir: text(flat.MEDIA_STORAGE_DIR, DEFAULT_MEDIA_RUNTIME.storageDir),
    maxFileMb: num(flat.MEDIA_MAX_FILE_MB, DEFAULT_MEDIA_RUNTIME.maxFileMb, 1, 2048),
    allowedTypes: (() => {
      const raw = flat.MEDIA_ALLOWED_TYPES?.trim();
      if (!raw) return DEFAULT_MEDIA_RUNTIME.allowedTypes;
      return raw
        .split(/[,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    })(),
    publicBaseUrl: text(flat.MEDIA_PUBLIC_BASE_URL, DEFAULT_MEDIA_RUNTIME.publicBaseUrl),
    contentHistoryLimit: num(flat.CONTENT_HISTORY_LIMIT, DEFAULT_MEDIA_RUNTIME.contentHistoryLimit, 0, 200),
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
    jsonMaxTokens: num(flat.AI_JSON_MAX_TOKENS, DEFAULT_AI_RUNTIME.jsonMaxTokens, 512, 32_000),
    priceInputPerMTok: float(flat.AI_PRICE_INPUT_PER_MTOK, DEFAULT_AI_RUNTIME.priceInputPerMTok, 0, 10_000),
    priceCachedInputPerMTok: float(flat.AI_PRICE_CACHED_INPUT_PER_MTOK, DEFAULT_AI_RUNTIME.priceCachedInputPerMTok, 0, 10_000),
    priceOutputPerMTok: float(flat.AI_PRICE_OUTPUT_PER_MTOK, DEFAULT_AI_RUNTIME.priceOutputPerMTok, 0, 10_000),
    rateLimitPerMinute: num(flat.AI_RATE_LIMIT_PER_MINUTE, DEFAULT_AI_RUNTIME.rateLimitPerMinute, 0, 10_000),
    dailyTokenQuota: num(flat.AI_DAILY_TOKEN_QUOTA, DEFAULT_AI_RUNTIME.dailyTokenQuota, 0, 1_000_000_000),
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

  snapshot.auth = {
    accessExpires: text(flat.AUTH_ACCESS_EXPIRES, DEFAULT_AUTH_RUNTIME.accessExpires),
    refreshExpires: text(flat.AUTH_REFRESH_EXPIRES, DEFAULT_AUTH_RUNTIME.refreshExpires),
  };

  const parsedMatrix = parseJson<Record<string, string[]>>(flat.PERMISSION_MATRIX, DEFAULT_PERMISSION_MATRIX_RUNTIME, onError);
  const parsedLabels = parseJson<Record<string, string>>(flat.ROLE_LABELS, DEFAULT_ROLE_LABELS_RUNTIME, onError);
  snapshot.permissions = {
    matrix:
      parsedMatrix && typeof parsedMatrix === 'object' && Object.keys(parsedMatrix).length > 0
        ? Object.fromEntries(
            Object.entries(parsedMatrix).map(([capability, roles]) => [
              capability,
              Array.isArray(roles) ? roles.map((role) => String(role)) : [],
            ]),
          )
        : { ...DEFAULT_PERMISSION_MATRIX_RUNTIME },
    roleLabels:
      parsedLabels && typeof parsedLabels === 'object' && Object.keys(parsedLabels).length > 0
        ? Object.fromEntries(Object.entries(parsedLabels).map(([code, label]) => [code, String(label)]))
        : { ...DEFAULT_ROLE_LABELS_RUNTIME },
  };

  snapshot.publish = {
    streamName: text(flat.PUBLISH_STREAM_NAME, DEFAULT_PUBLISH_RUNTIME.streamName),
    groupName: text(flat.PUBLISH_GROUP_NAME, DEFAULT_PUBLISH_RUNTIME.groupName),
    maxLen: num(flat.PUBLISH_STREAM_MAXLEN, DEFAULT_PUBLISH_RUNTIME.maxLen, 1_000, 1_000_000),
    notificationRetentionDays: num(flat.NOTIFICATION_RETENTION_DAYS, DEFAULT_PUBLISH_RUNTIME.notificationRetentionDays, 0, 3650),
    aiMetadataEnabled: bool(flat.AI_METADATA_ENABLED, DEFAULT_PUBLISH_RUNTIME.aiMetadataEnabled),
    readBlockMs: num(flat.PUBLISH_READ_BLOCK_MS, DEFAULT_PUBLISH_RUNTIME.readBlockMs, 200, 60_000),
    readCount: num(flat.PUBLISH_READ_COUNT, DEFAULT_PUBLISH_RUNTIME.readCount, 1, 100),
    claimIdleMs: num(flat.PUBLISH_CLAIM_IDLE_MS, DEFAULT_PUBLISH_RUNTIME.claimIdleMs, 5_000, 3_600_000),
    maxAttempts: num(flat.PUBLISH_MAX_ATTEMPTS, DEFAULT_PUBLISH_RUNTIME.maxAttempts, 1, 10),
    retryIntervalMs: num(flat.PUBLISH_RETRY_INTERVAL_MS, DEFAULT_PUBLISH_RUNTIME.retryIntervalMs, 1000, 86_400_000),
    workerEnabled: bool(flat.PUBLISH_WORKER_ENABLED, DEFAULT_PUBLISH_RUNTIME.workerEnabled),
    stuckMinutes: num(flat.PUBLISH_STUCK_MINUTES, DEFAULT_PUBLISH_RUNTIME.stuckMinutes, 1, 1440),
  };
}

/** 设置页用的默认值快照（导出配置、生成文档时用）。 */
export function defaultConfigSnapshot(): RuntimeConfig {
  return {
    site: { ...DEFAULT_SITE },
    auth: { ...DEFAULT_AUTH_RUNTIME },
    media: { ...DEFAULT_MEDIA_RUNTIME },
    notify: { ...DEFAULT_NOTIFY_RUNTIME },
    knowledge: { ...DEFAULT_KNOWLEDGE_RUNTIME },
    ai: { ...DEFAULT_AI_RUNTIME, platformGuidance: { ...DEFAULT_AI_RUNTIME.platformGuidance } },
    compliance: DEFAULT_COMPLIANCE_RULES.map((rule) => ({ ...rule, terms: [...rule.terms] })),
    publish: { ...DEFAULT_PUBLISH_RUNTIME },
    permissions: {
      matrix: { ...DEFAULT_PERMISSION_MATRIX_RUNTIME },
      roleLabels: { ...DEFAULT_ROLE_LABELS_RUNTIME },
    },
  };
}
