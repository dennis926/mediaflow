import { NavLink } from 'react-router-dom';

const tabs = [
  { to: '/dashboard', label: '工作台' },
  { to: '/publish/queue', label: '队列' },
  { to: '/approval', label: '审批' },
  { to: '/profile', label: '我的' },
];

export function TabBar() {
  return (
    <nav className="tabbar">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to}>
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
