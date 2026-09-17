'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { Card } from '../../../../components/ui/Card';
import { SkeletonRows } from '../../../../components/ui/Skeleton';

/** Legacy entry point: /content/edit?id=xxx redirects to /content/xxx/edit. */
function LegacyEditorRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get('id');

  useEffect(() => {
    router.replace(id ? `/content/${id}/edit` : '/content/new');
  }, [id, router]);

  return (
    <Card title="内容编辑器">
      <SkeletonRows rows={6} />
    </Card>
  );
}

export default function LegacyEditPage() {
  return (
    <Suspense fallback={<Card title="内容编辑器"><SkeletonRows rows={6} /></Card>}>
      <LegacyEditorRedirect />
    </Suspense>
  );
}
