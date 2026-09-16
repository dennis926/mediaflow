'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '../lib/api/client';

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    router.replace(getToken() ? '/dashboard' : '/login');
  }, [router]);

  return null;
}
