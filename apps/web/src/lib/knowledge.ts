import { useQuery } from '@tanstack/react-query';
import { knowledgeApi, publicApi } from './api/endpoints';
import type { KnowledgeCategoryView, SiteConfigView } from './api/types';

export type KnowledgeTone = 'brand' | 'success' | 'info' | 'warning' | 'danger' | 'default';

export interface KnowledgeCategoryDef {
  code: string;
  label: string;
  tone: KnowledgeTone;
  description?: string;
}

/** 与后端 DEFAULT_KNOWLEDGE_CATEGORIES 保持一致：仅在分类接口返回前做首屏兜底。 */
export const DEFAULT_CATEGORIES: KnowledgeCategoryDef[] = [
  { code: 'brand', label: '品牌定位', tone: 'brand', description: '品牌是谁、面向谁、什么调性、红线在哪' },
  { code: 'product', label: '产品卖点', tone: 'success', description: '配方、规格、工艺、认证等可验证事实' },
  { code: 'ingredient', label: '成分说明', tone: 'info', description: '单一成分的作用、来源与适用人群' },
  { code: 'compliance', label: '合规红线', tone: 'danger', description: '不能写的表述与替换说法' },
  { code: 'faq', label: '常见问答', tone: 'warning', description: '用户常问的问题与标准回答口径' },
  { code: 'tone', label: '话术基调', tone: 'default', description: '语气、称谓与结构偏好' },
];

export const CATEGORY_TONES: Record<string, KnowledgeTone> = Object.fromEntries(
  DEFAULT_CATEGORIES.map((item) => [item.code, item.tone]),
);

export const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  DEFAULT_CATEGORIES.map((item) => [item.code, item.label]),
);

/** 分类是配置项：界面上的下拉、标签、配色都从这里取，改配置即时生效。 */
export function useKnowledgeCategories(): {
  categories: KnowledgeCategoryView[];
  label: (code: string) => string;
  tone: (code: string) => KnowledgeTone;
  isLoading: boolean;
} {
  const query = useQuery({ queryKey: ['knowledge', 'categories'], queryFn: () => knowledgeApi.categories(), staleTime: 60_000 });
  const list: KnowledgeCategoryView[] = query.data?.categories ?? DEFAULT_CATEGORIES.map((item) => ({ ...item, count: 0 }));

  return {
    categories: list,
    label: (code: string) => list.find((item) => item.code === code)?.label ?? code,
    tone: (code: string) => (list.find((item) => item.code === code)?.tone ?? 'default') as KnowledgeTone,
    isLoading: query.isLoading,
  };
}

/** 从留档路径里取原始文件名，用于展示"这条资料来自哪个文件"。 */
export function sourceFileName(sourceUrl: string | null): string {
  if (!sourceUrl) return '';
  const parts = sourceUrl.split('/');
  const name = parts[parts.length - 1] ?? '';
  // 留档名形如 1789652809900-产品卖点.docx，去掉时间戳前缀
  return name.replace(/^\d{10,}-/, '');
}

export const IMPORT_ACCEPT = '.pdf,.docx,.pptx,.xlsx,.xls,.csv,.txt,.md,.markdown';


const FALLBACK_SITE: SiteConfigView = {
  name: 'MediaFlow',
  tagline: '内容分发与矩阵运营',
  company: '',
  supportEmail: '',
  brandColor: '#4F6BFF',
  logoUrl: '',
  pageSize: 10,
  aiDisclosureSuffix: '（本文由 AI 辅助生成）',
};

/** 站点名称/副标题/每页条数都来自后台配置，换公司改配置即可，无需改代码。 */
export function useSiteConfig(): SiteConfigView {
  const query = useQuery({ queryKey: ['public', 'site-config'], queryFn: () => publicApi.siteConfig(), staleTime: 300_000 });
  return query.data ?? FALLBACK_SITE;
}
