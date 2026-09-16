import { PageHeader } from '../components/PageHeader';

export function PlaceholderPage({ title, hint }: { title: string; hint: string }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="app-main">
        <div className="card">
          <span className="muted">{hint}</span>
        </div>
      </div>
    </>
  );
}
