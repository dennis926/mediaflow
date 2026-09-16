import { Navigate, Route, Routes } from 'react-router-dom';
import { TabBar } from './components/TabBar';
import { PlaceholderPage } from './pages/PlaceholderPage';

export function App() {
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<PlaceholderPage title="登录" hint="移动端登录页待实现。" />} />
        <Route path="/dashboard" element={<PlaceholderPage title="工作台" hint="数据卡片待实现。" />} />
        <Route path="/publish/queue" element={<PlaceholderPage title="发布队列" hint="任务列表待实现。" />} />
        <Route path="/approval" element={<PlaceholderPage title="审批" hint="审批列表待实现。" />} />
        <Route path="/profile" element={<PlaceholderPage title="我的" hint="个人中心待实现。" />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      <TabBar />
    </div>
  );
}
