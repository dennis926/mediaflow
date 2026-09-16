import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { TabBar } from './components/TabBar';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { QueuePage } from './pages/QueuePage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { getToken } from './lib/api/client';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!getToken()) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

export function App() {
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/dashboard"
          element={
            <RequireAuth>
              <DashboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/publish/queue"
          element={
            <RequireAuth>
              <QueuePage />
            </RequireAuth>
          }
        />
        <Route
          path="/publish/task/:id"
          element={
            <RequireAuth>
              <TaskDetailPage />
            </RequireAuth>
          }
        />
        <Route
          path="/approval"
          element={
            <RequireAuth>
              <PlaceholderPage title="审批" hint="审批中心将在后续阶段实现（内容审批、发布审批）。" />
            </RequireAuth>
          }
        />
        <Route
          path="/profile"
          element={
            <RequireAuth>
              <PlaceholderPage title="我的" hint="账号信息与退出登录将在后续阶段实现。" />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      <TabBar />
    </div>
  );
}
