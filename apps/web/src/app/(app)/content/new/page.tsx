'use client';

import { useSearchParams } from 'next/navigation';
import { ContentEditor } from '../../../../components/content/ContentEditor';

export default function NewContentPage(): React.JSX.Element {
  const params = useSearchParams();
  // 支持 /content/new?template=<id>：从模板库一键开始写作
  return <ContentEditor mode="new" templateId={params?.get('template') ?? null} />;
}
