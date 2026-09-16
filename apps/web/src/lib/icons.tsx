import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const BASE: IconProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

export function DashboardIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  );
}

export function ContentIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h7M9 17h5" />
    </svg>
  );
}

export function PublishIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M4 12l16-8-6 16-3-6z" />
      <path d="M11 14l3-3" />
    </svg>
  );
}

export function AnalyticsIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M8 15v-4M12 15V8M16 15v-6" />
    </svg>
  );
}

export function AccountIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
    </svg>
  );
}

export function SparkleIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
      <path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17.5h.01" />
    </svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
    </svg>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M14 5l4 4" />
    </svg>
  );
}

export function LogoutIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M10 5H6v14h4" />
      <path d="M15 8l4 4-4 4M19 12H9" />
    </svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <rect x="3.5" y="5" width="17" height="16" rx="2" />
      <path d="M3.5 10h17M8 3.5v3M16 3.5v3" />
    </svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v5h-5" />
    </svg>
  );
}

export function InboxIcon(props: IconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M4 6h16v12H4z" />
      <path d="M4 13h4l1 2h6l1-2h4" />
    </svg>
  );
}
