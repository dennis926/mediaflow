import Link from 'next/link';

// Placeholder shell. The dashboard experience is implemented in the PC Web stage.
export default function HomePage() {
  return (
    <main style={{ padding: 'var(--mf-space-8)' }}>
      <h1 style={{ fontSize: 'var(--mf-font-size-3xl)', marginBottom: 'var(--mf-space-4)' }}>MediaFlow</h1>
      <p style={{ color: 'var(--mf-color-text-secondary)' }}>内容分发与矩阵运营平台 · 项目初始化完成</p>
      <p style={{ marginTop: 'var(--mf-space-6)' }}>
        <Link href="/dashboard">进入工作台</Link>
      </p>
    </main>
  );
}
