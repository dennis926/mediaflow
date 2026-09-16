import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { BackIcon } from './icons';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  back?: boolean;
  action?: ReactNode;
}

export function PageHeader({ title, subtitle, back = false, action }: PageHeaderProps) {
  const navigate = useNavigate();
  return (
    <header className="page-header">
      {back ? (
        <button type="button" className="icon-button" aria-label="返回" onClick={() => navigate(-1)}>
          <BackIcon />
        </button>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <h1>{title}</h1>
        {subtitle ? <span className="subtitle">{subtitle}</span> : null}
      </div>
      <div style={{ marginLeft: 'auto' }}>{action}</div>
    </header>
  );
}
