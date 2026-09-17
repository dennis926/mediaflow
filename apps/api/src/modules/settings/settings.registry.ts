export type SettingGroup = 'ai' | 'platform' | 'publish' | 'knowledge';

export interface SettingDefinition {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  secret: boolean;
  /** Environment variable used as the fallback when nothing is stored in the database. */
  envKey: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
}

/**
 * Every configurable key lives here. The database wins over the environment, so an operator
 * can configure the system from the UI while a fresh clone still works from .env only.
 */
export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: 'AI_PROVIDER',
    group: 'ai',
    label: 'AI 提供方',
    description: 'mock = 离线模板（不消耗额度），deepseek = 真实调用',
    secret: false,
    envKey: 'AI_PROVIDER',
    options: [
      { value: 'deepseek', label: 'DeepSeek（真实调用）' },
      { value: 'mock', label: '离线模板（不调用外部接口）' },
    ],
  },
  {
    key: 'AI_MODEL',
    group: 'ai',
    label: '模型名称',
    description: 'DeepSeek 模型标识别，例如 deepseek-v4-flash-0731',
    secret: false,
    envKey: 'AI_MODEL',
    placeholder: 'deepseek-v4-flash-0731',
  },
  {
    key: 'AI_API_KEY',
    group: 'ai',
    label: 'AI API Key',
    description: 'DeepSeek 密钥；加密存储在数据库中，界面上只显示后四位',
    secret: true,
    envKey: 'AI_API_KEY',
    placeholder: 'sk-...',
  },
  {
    key: 'AI_API_BASE',
    group: 'ai',
    label: 'AI 接口地址',
    description: '留空使用官方地址 https://api.deepseek.com',
    secret: false,
    envKey: 'AI_API_BASE',
    placeholder: 'https://api.deepseek.com',
  },
  {
    key: 'KB_CATEGORIES',
    group: 'knowledge',
    label: '知识库分类配置',
    description: 'JSON 数组。平时不用手改——在「知识库管理 → 分类设置」里增删改即可，这里显示当前值，也方便整包配置导入导出',
    secret: false,
    envKey: 'KB_CATEGORIES',
    placeholder: '[{"code":"product","label":"产品卖点","tone":"success","description":"配方、规格、工艺"}]',
  },
  {
    key: 'WECHAT_MP_APP_ID',
    group: 'platform',
    label: '公众号 AppID',
    description: '用于拉取图文分析数据；公众号禁止 API 发布，仅供人工发布',
    secret: false,
    envKey: 'WECHAT_MP_APP_ID',
  },
  {
    key: 'WECHAT_MP_APP_SECRET',
    group: 'platform',
    label: '公众号 AppSecret',
    description: '加密存储',
    secret: true,
    envKey: 'WECHAT_MP_APP_SECRET',
  },
  {
    key: 'DOUYIN_CLIENT_KEY',
    group: 'platform',
    label: '抖音 Client Key',
    description: '发布接口需要 OAuth 授权；互动接口不可用',
    secret: false,
    envKey: 'DOUYIN_CLIENT_KEY',
  },
  {
    key: 'DOUYIN_CLIENT_SECRET',
    group: 'platform',
    label: '抖音 Client Secret',
    description: '加密存储',
    secret: true,
    envKey: 'DOUYIN_CLIENT_SECRET',
  },
  {
    key: 'XIAOHONGSHU_APP_ID',
    group: 'platform',
    label: '小红书 App ID',
    description: '需企业资质认证',
    secret: false,
    envKey: 'XIAOHONGSHU_APP_ID',
  },
  {
    key: 'XIAOHONGSHU_APP_SECRET',
    group: 'platform',
    label: '小红书 App Secret',
    description: '加密存储',
    secret: true,
    envKey: 'XIAOHONGSHU_APP_SECRET',
  },
  {
    key: 'XIAOHONGSHU_API_BASE',
    group: 'platform',
    label: '小红书开放平台地址',
    description: '留空时适配器不发起请求，只返回明确报错',
    secret: false,
    envKey: 'XIAOHONGSHU_API_BASE',
  },
  {
    key: 'REQUIRE_CONTENT_APPROVAL',
    group: 'publish',
    label: '发布前必须审核通过',
    description: '开启后，只有审核状态为「已通过」的内容才能创建发布任务',
    secret: false,
    envKey: 'REQUIRE_CONTENT_APPROVAL',
    options: [
      { value: 'true', label: '开启（推荐多人协作）' },
      { value: 'false', label: '关闭（小团队直接发布）' },
    ],
  },
  {
    key: 'PUBLISH_WORKER_ENABLED',
    group: 'publish',
    label: '启用发布 Worker',
    description: '关闭后任务只入队不执行（修改后需重启 API 生效）',
    secret: false,
    envKey: 'PUBLISH_WORKER_ENABLED',
    options: [
      { value: 'true', label: '启用' },
      { value: 'false', label: '停用' },
    ],
  },
  {
    key: 'PUBLISH_RETRY_INTERVAL_MS',
    group: 'publish',
    label: '失败重试间隔（毫秒）',
    description: '默认 300000（5 分钟）',
    secret: false,
    envKey: 'PUBLISH_RETRY_INTERVAL_MS',
    placeholder: '300000',
  },
];

export const SETTING_BY_KEY = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

export const SETTING_GROUP_LABELS: Record<SettingGroup, string> = {
  ai: 'AI 服务',
  platform: '平台密钥',
  publish: '发布队列',
  knowledge: '知识库',
};
