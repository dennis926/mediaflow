import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { MustChangePasswordGate } from './components/MustChangePasswordGate';
import { TabBar } from './components/TabBar';
import { ApprovalPage } from './pages/ApprovalPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { ProfilePage } from './pages/ProfilePage';
import { QueuePage } from './pages/QueuePage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { getToken } from './lib/api/client';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!getToken()) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <MustChangePasswordGate>{children}</MustChangePasswordGate>;
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
              <ApprovalPage />
            </RequireAuth>
          }
        />
        <Route
          path="/profile"
          element={
            <RequireAuth>
              <ProfilePage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      <TabBar />
    </div>
  );
}
