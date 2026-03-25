import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IdentityProvider } from './lib/identity';
import { Navbar } from './components/Navbar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Dashboard } from './pages/Dashboard';
import { BotList } from './pages/BotList';
import { TaskList } from './pages/TaskList';
import { TaskDetail } from './pages/TaskDetail';
import { BotDetail } from './pages/BotDetail';
import { SessionList } from './pages/SessionList';
import { RouteHistory } from './pages/RouteHistory';
import { MePage } from './pages/MePage';
import { Inbox } from './pages/Inbox';
import { TeamPage } from './pages/TeamPage';
import { CloudFilesPage } from './pages/CloudFiles';
import { useWebSocket } from './hooks/useWebSocket';
import { useRouterWebSocket } from './hooks/useRouterWebSocket';
import { I18nProvider } from './lib/i18n';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5000,
    },
  },
});

function AppContent() {
  const { isConnected } = useWebSocket();
  const { isConnected: routerConnected } = useRouterWebSocket();

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar connectionStatus={{ api: isConnected, router: routerConnected }} />
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/bots" element={<BotList />} />
          <Route path="/bots/:botId" element={<BotDetail />} />
          <Route path="/tasks" element={<TaskList />} />
          <Route path="/tasks/:taskId" element={<TaskDetail />} />
          <Route path="/files" element={<CloudFilesPage />} />
          <Route path="/sessions" element={<SessionList />} />
          <Route path="/routes" element={<RouteHistory />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/team" element={<TeamPage />} />
          <Route path="/me" element={<MePage />} />
        </Routes>
      </ErrorBoundary>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <BrowserRouter>
          <IdentityProvider>
            <AppContent />
          </IdentityProvider>
        </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
}

export default App;
