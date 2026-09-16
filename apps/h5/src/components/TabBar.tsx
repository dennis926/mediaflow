import { NavLink } from 'react-router-dom';
import { ContentIcon, DashboardIcon, PublishIcon, AccountIcon } from './icons';

const TABS = [
  { to: '/dashboard', label: '工作台', icon: <DashboardIcon /> },
  { to: '/publish/queue', label: '队列', icon: <PublishIcon /> },
  { to: '/approval', label: '审批', icon: <ContentIcon /> },
  { to: '/profile', label: '我的', icon: <AccountIcon /> },
];

export function TabBar() {
  return (
    <nav className="tabbar" aria-label="底部导航">
      {TABS.map((tab) => (
        <NavLink key={tab.to} to={tab.to}>
          {tab.icon}
          <span>{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
