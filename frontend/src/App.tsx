// src/App.tsx
import React, { lazy, Suspense, useEffect, useSyncExternalStore } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import PrivateRoute from './components/common/PrivateRoute';
import PageLoading from './components/common/PageLoading';
import RouteErrorBoundary from './components/common/RouteErrorBoundary';
import { getSessionGeneration, registerSessionReset } from './utils/authSession';
import { subscribeToSessionStorage } from './services/authSessionService';
import { isAuthenticated } from './utils/auth';
import { I18nProvider, useI18n } from './i18n';

const WorkspaceLayout = lazy(() => import('./layouts/WorkspaceLayout'));
const Workspace = lazy(() => import('./pages/Workspace'));
const ChatSystem = lazy(() => import('./pages/ChatSystem'));
const GraphEditor = lazy(() => import('./pages/GraphEditor'));
const ModelManager = lazy(() => import('./pages/ModelManager'));
const MCPManager = lazy(() => import('./pages/MCPManager'));
const PromptManager = lazy(() => import('./pages/PromptManager'));
const AgentManager = lazy(() => import('./pages/AgentManager'));
const SystemToolsManager = lazy(() => import('./pages/SystemToolsManager'));
const ExportManager = lazy(() => import('./pages/ExportManager'));
const TaskManager = lazy(() => import('./pages/TaskManager'));
const TaskDetail = lazy(() => import('./pages/TaskDetail'));
const PreviewPage = lazy(() => import('./pages/PreviewPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const AdminPanel = lazy(() => import('./pages/AdminPanel'));
const FileManager = lazy(() => import('./pages/FileManager'));
const MemoryManager = lazy(() => import('./pages/MemoryManager'));
const SharedConversation = lazy(() => import('./pages/SharedConversation'));
const Projects = lazy(() => import('./pages/Projects'));
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'));

// AppContent component that uses i18n context
const AppContent: React.FC = () => {
  const { locale } = useI18n();
  const sessionGeneration = useSyncExternalStore(registerSessionReset, getSessionGeneration);
  const antdLocale = locale === 'zh' ? zhCN : enUS;

  // 公开分享页也保留身份监听，确保其间的账号变化使所有已加载 store 失效。
  useEffect(subscribeToSessionStorage, []);

  useEffect(() => {
    // 设置页面标题
    document.title = "Agent-Graph";
  }, []);

  return (
    <ConfigProvider
      locale={antdLocale}
      theme={{
        token: {
          colorPrimary: '#b85845',
          colorPrimaryHover: '#a0826d',
          colorBorder: 'rgba(139, 115, 85, 0.2)',
          colorBorderSecondary: 'rgba(139, 115, 85, 0.15)',
          colorText: '#2d2d2d',
          colorTextPlaceholder: 'rgba(45, 45, 45, 0.35)',
          borderRadius: 6,
          controlHeight: 40,
        },
        components: {
          Input: {
            activeBorderColor: '#b85845',
            hoverBorderColor: 'rgba(184, 88, 69, 0.4)',
            activeShadow: '0 0 0 2px rgba(184, 88, 69, 0.1)',
          },
          InputNumber: {
            activeBorderColor: '#b85845',
            hoverBorderColor: 'rgba(184, 88, 69, 0.4)',
            activeShadow: '0 0 0 2px rgba(184, 88, 69, 0.1)',
          },
          Select: {
            optionSelectedBg: 'rgba(184, 88, 69, 0.08)',
            optionActiveBg: 'rgba(184, 88, 69, 0.05)',
          },
        },
      }}
    >
      <AntApp>
        <Router>
          <RouteErrorBoundary key={sessionGeneration}>
            <Suspense fallback={<PageLoading />}>
      <Routes>
        {/* 公开路由 - 登录和注册 */}
        <Route
          path="/login"
          element={isAuthenticated() ? <Navigate to="/workspace" replace /> : <LoginPage />}
        />
        <Route
          path="/register"
          element={isAuthenticated() ? <Navigate to="/workspace" replace /> : <RegisterPage />}
        />

        {/* 公开路由 - 分享页面（无需登录） */}
        <Route path="/share/:shareId" element={<SharedConversation />} />

        {/* 根路径重定向到工作台 */}
        <Route path="/" element={<Navigate to="/workspace" replace />} />

        {/* 受保护的路由 - 对话系统 */}
        <Route path="/chat" element={
          <PrivateRoute>
            <ChatSystem />
          </PrivateRoute>
        } />
        <Route path="/chat/:conversationId" element={
          <PrivateRoute>
            <ChatSystem />
          </PrivateRoute>
        } />

        {/* 受保护的路由 - 任务管理 */}
        <Route path="/tasks" element={
          <PrivateRoute>
            <TaskManager />
          </PrivateRoute>
        } />
        <Route path="/tasks/:taskId" element={
          <PrivateRoute>
            <TaskDetail />
          </PrivateRoute>
        } />

        {/* 受保护的路由 - 导出管理 */}
        <Route path="/export" element={
          <PrivateRoute>
            <ExportManager />
          </PrivateRoute>
        } />

        {/* 受保护的路由 - 可分享预览页面 */}
        <Route path="/preview" element={
          <PrivateRoute>
            <PreviewPage />
          </PrivateRoute>
        } />

        {/* 受保护的路由 - 工作台入口 */}
        <Route path="/workspace" element={
          <PrivateRoute>
            <Workspace />
          </PrivateRoute>
        } />

        {/* 受保护的路由 - 工作台子页面 */}
        <Route
          path="/workspace/agent-manager"
          element={
            <PrivateRoute>
              <WorkspaceLayout>
                <AgentManager />
              </WorkspaceLayout>
            </PrivateRoute>
          }
        />
        <Route
          path="/workspace/graph-editor"
          element={
            <PrivateRoute>
              <WorkspaceLayout>
                <GraphEditor />
              </WorkspaceLayout>
            </PrivateRoute>
          }
        />
        <Route
          path="/workspace/model-manager"
          element={
            <PrivateRoute>
              <WorkspaceLayout>
                <ModelManager />
              </WorkspaceLayout>
            </PrivateRoute>
          }
        />
        <Route
          path="/workspace/system-tools"
          element={
            <PrivateRoute>
              <WorkspaceLayout>
                <SystemToolsManager />
              </WorkspaceLayout>
            </PrivateRoute>
          }
        />
        <Route
          path="/workspace/mcp-manager"
          element={
            <PrivateRoute>
              <WorkspaceLayout>
                <MCPManager />
              </WorkspaceLayout>
            </PrivateRoute>
          }
        />
        <Route
          path="/workspace/prompt-manager"
          element={
            <PrivateRoute>
              <WorkspaceLayout>
                <PromptManager />
              </WorkspaceLayout>
            </PrivateRoute>
          }
        />
        <Route
          path="/workspace/file-manager"
          element={
            <PrivateRoute>
              <WorkspaceLayout>
                <FileManager />
              </WorkspaceLayout>
            </PrivateRoute>
          }
        />
        <Route
          path="/workspace/memory-manager"
          element={
            <PrivateRoute>
              <WorkspaceLayout>
                <MemoryManager />
              </WorkspaceLayout>
            </PrivateRoute>
          }
        />
        <Route
          path="/workspace/projects"
          element={
            <PrivateRoute>
              <WorkspaceLayout>
                <Projects />
              </WorkspaceLayout>
            </PrivateRoute>
          }
        />
        <Route
          path="/workspace/projects/:projectId"
          element={
            <PrivateRoute>
              <WorkspaceLayout>
                <ProjectDetail />
              </WorkspaceLayout>
            </PrivateRoute>
          }
        />

        {/* 受保护的路由 - 管理员页面 */}
        <Route path="/admin" element={
          <PrivateRoute>
            <AdminPanel />
          </PrivateRoute>
        } />

        {/* 重定向旧路由到新的工作台路由 */}
        <Route path="/graph-editor" element={<Navigate to="/workspace/graph-editor" replace />} />
        <Route path="/model-manager" element={<Navigate to="/workspace/model-manager" replace />} />
        <Route path="/mcp-manager" element={<Navigate to="/workspace/mcp-manager" replace />} />
        <Route path="/prompt-manager" element={<Navigate to="/workspace/prompt-manager" replace />} />

        {/* 默认重定向 */}
        <Route path="*" element={<Navigate to="/workspace" replace />} />
      </Routes>
            </Suspense>
          </RouteErrorBoundary>
        </Router>
      </AntApp>
    </ConfigProvider>
  );
};

// Main App component wrapped with I18nProvider
const App: React.FC = () => {
  return (
    <I18nProvider>
      <AppContent />
    </I18nProvider>
  );
};

export default App;
