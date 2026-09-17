/** 知识库分类的中文名与配色，列表与导入复核对齐使用。 */
export const CATEGORY_LABELS: Record<string, string> = {
  brand: '品牌定位',
  product: '产品卖点',
  ingredient: '成分说明',
  compliance: '合规红线',
  faq: '常见问答',
  tone: '话术基调',
};

export const CATEGORY_TONES: Record<string, 'brand' | 'info' | 'success' | 'danger' | 'warning' | 'default'> = {
  brand: 'brand',
  product: 'success',
  ingredient: 'info',
  compliance: 'danger',
  faq: 'warning',
  tone: 'default',
};

/** 导入时用的文件类型白名单（与后端 SUPPORTED_DOCUMENT_TYPES 保持一致）。 */
export const IMPORT_ACCEPT = '.pdf,.docx,.pptx,.xlsx,.xls,.csv,.txt,.md,.markdown';

/** 从留档路径里取原始文件名，用于展示"这条资料来自哪个文件"。 */
export function sourceFileName(sourceUrl: string | null): string {
  if (!sourceUrl) return '';
  const parts = sourceUrl.split('/');
  const name = parts[parts.length - 1] ?? '';
  // 留档名形如 1789652809900-产品卖点.docx，去掉时间戳前缀
  return name.replace(/^\d{10,}-/, '');
}
