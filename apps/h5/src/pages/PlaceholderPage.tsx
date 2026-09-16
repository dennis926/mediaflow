interface PlaceholderPageProps {
  title: string;
  hint: string;
}

// Skeleton only: the full mobile experience ships in the H5 stage.
export function PlaceholderPage({ title, hint }: PlaceholderPageProps) {
  return (
    <section className="page">
      <h1 className="page-title">{title}</h1>
      <p className="placeholder">{hint}</p>
    </section>
  );
}
