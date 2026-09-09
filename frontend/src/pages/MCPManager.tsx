import React, { useEffect, useState, useRef } from 'react';
import { Layout, Row, Col, Alert, App } from 'antd';
import { Grid3x3 } from 'lucide-react';
import { useMCPStore } from '../store/mcpStore';
import MCPServerForm from '../components/mcp-manager/MCPServerForm';
import MCPServerCard from '../components/mcp-manager/MCPServerCard';
import MCPToolsViewer from '../components/mcp-manager/MCPToolsViewer';
import MCPJsonEditor from '../components/mcp-manager/MCPJsonEditor';
import MCPManagerHeader from '../components/mcp-manager/MCPManagerHeader';
import { MCPServerConfig, MCPConfig } from '../types/mcp';
import { getUserInfo } from '../utils/auth';
import { useT } from '../i18n/hooks';
import { MCP_COLORS, getMCPEmptyStateStyle } from '../constants/mcpManagerStyles';

const { Content } = Layout;

const MCPManager: React.FC = () => {
  const t = useT();
  const { message } = App.useApp();
  const config = useMCPStore(state => state.config);
  const status = useMCPStore(state => state.status);
  const loading = useMCPStore(state => state.loading);
  const error = useMCPStore(state => state.error);
  const fetchConfig = useMCPStore(state => state.fetchConfig);
  const fetchStatus = useMCPStore(state => state.fetchStatus);
  const updateConfig = useMCPStore(state => state.updateConfig);
  const addServer = useMCPStore(state => state.addServer);
  const updateServer = useMCPStore(state => state.updateServer);
  const deleteServer = useMCPStore(state => state.deleteServer);
  const connectServer = useMCPStore(state => state.connectServer);
  const disconnectServer = useMCPStore(state => state.disconnectServer);
  const connectAllServers = useMCPStore(state => state.connectAllServers);

  // 获取当前用户信息
  const currentUser = getUserInfo();

  const formSession = useRef(0);
  const [modalVisible, setModalVisible] = useState(false);
  const [toolsModalVisible, setToolsModalVisible] = useState(false);
  const [selectedServer, setSelectedServer] = useState('');
  const [initialValues, setInitialValues] = useState<MCPServerConfig | undefined>();
  const [modalTitle, setModalTitle] = useState('');
  const [viewMode, setViewMode] = useState<'visual' | 'json'>('visual');

  useEffect(() => {
    fetchConfig();
    fetchStatus();
    return () => { formSession.current += 1; };
  }, [fetchConfig, fetchStatus]);

  const showAddModal = () => {
    formSession.current += 1;
    setSelectedServer('');
    setInitialValues(undefined);
    setModalTitle(t('pages.mcpManager.addServerTitle'));
    setModalVisible(true);
  };

  const showEditModal = (serverName: string) => {
    formSession.current += 1;
    setSelectedServer(serverName);
    setInitialValues(config.mcpServers[serverName]);
    setModalTitle(t('pages.mcpManager.editServerTitle', { name: serverName }));
    setModalVisible(true);
  };

  const showToolsModal = (serverName: string) => {
    setSelectedServer(serverName);
    setToolsModalVisible(true);
  };

  const handleFormSubmit = async (serverName: string, serverConfig: MCPServerConfig) => {
    const owner = formSession.current;
    try {
      if (selectedServer) {
        // Edit existing server
        await updateServer(selectedServer, serverConfig);
        if (owner !== formSession.current) return;
        message.success(t('pages.mcpManager.serverUpdateSuccess', { name: selectedServer }));
      } else {
        // Add new server
        if (config.mcpServers[serverName]) {
          throw new Error(t('pages.mcpManager.serverExists', { name: serverName }));
        }
        await addServer(serverName, serverConfig);
        if (owner !== formSession.current) return;
        message.success(t('pages.mcpManager.serverAddSuccess', { name: serverName }));
      }
      setModalVisible(false);
    } catch (err) {
      if (owner !== formSession.current) throw err;
      if (err instanceof Error && 'isVersionConflict' in err && err.isVersionConflict) {
        message.error({
          content: t('pages.mcpManager.versionConflict', { message: err.message }),
          duration: 5
        });
      } else {
        message.error(t('pages.mcpManager.operationFailed', { error: err instanceof Error ? err.message : String(err) }));
      }
      throw err;
    }
  };

  const handleDeleteServer = async (serverName: string) => {
    const owner = formSession.current;
    try {
      await deleteServer(serverName);
      if (owner !== formSession.current) return;
      message.success(t('pages.mcpManager.serverDeleteSuccess', { name: serverName }));
    } catch (err) {
      if (err instanceof Error && 'isVersionConflict' in err && err.isVersionConflict) {
        message.error({
          content: t('pages.mcpManager.versionConflict', { message: err.message }),
          duration: 5
        });
      } else {
        message.error(t('pages.mcpManager.deleteFailed', { error: err instanceof Error ? err.message : String(err) }));
      }
    }
  };

  const handleConnect = async (serverName: string) => {
    try {
      await connectServer(serverName);
      message.success(t('pages.mcpManager.connectSuccess', { name: serverName }));
    } catch (err) {
      message.error(t('pages.mcpManager.connectFailed', { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const handleDisconnect = async (serverName: string) => {
    try {
      await disconnectServer(serverName);
      message.success(t('pages.mcpManager.disconnectSuccess', { name: serverName }));
    } catch (err) {
      message.error(t('pages.mcpManager.disconnectFailed', { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const handleConnectAll = async () => {
    try {
      message.loading(t('pages.mcpManager.connectAllLoading'), 0);
      const results = await connectAllServers();
      message.destroy();

      if (results.success.length > 0 && results.failed.length === 0) {
        message.success(t('pages.mcpManager.connectAllSuccess', { count: results.success.length }));
      } else if (results.success.length > 0 && results.failed.length > 0) {
        message.warning(t('pages.mcpManager.connectAllPartial', { success: results.success.length, failed: results.failed.length }));
      } else if (results.success.length === 0 && results.failed.length > 0) {
        message.error(t('pages.mcpManager.connectAllFailed', { count: results.failed.length }));
      } else {
        message.info(t('pages.mcpManager.connectAllNone'));
      }
    } catch (err) {
      message.destroy();
      message.error(t('pages.mcpManager.connectAllError', { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const handleRefresh = () => {
    fetchConfig();
    fetchStatus();
    message.info(t('pages.mcpManager.refreshing'));
  };

  const handleSaveJson = async (newConfig: MCPConfig) => {
    try {
      await updateConfig(newConfig);
      message.success(t('pages.mcpManager.configSaveSuccess'));
      fetchStatus();
    } catch (err) {
      message.error(t('pages.mcpManager.configSaveFailed', { error: err instanceof Error ? err.message : String(err) }));
      throw err;
    }
  };

  const serverNames = Object.keys(config.mcpServers || {});
  const connectedCount = serverNames.filter(name => status[name]?.connected).length;

  return (
    <Layout style={{ height: '100vh', background: MCP_COLORS.background, display: 'flex', flexDirection: 'column' }}>
      <MCPManagerHeader
        title={t('pages.mcpManager.title')}
        serversCount={serverNames.length}
        connectedCount={connectedCount}
        viewMode={viewMode}
        onViewModeChange={() => setViewMode(viewMode === 'visual' ? 'json' : 'visual')}
        onAddServer={showAddModal}
        onRefresh={handleRefresh}
        onConnectAll={handleConnectAll}
        loading={loading}
        disabled={serverNames.length === 0}
        t={t}
      />

      <Content style={{
        flex: 1,
        padding: '32px 48px',
        overflow: 'auto'
      }}>
        {error && (
          <Alert
            message={t('common.error')}
            description={error}
            type="error"
            showIcon
            style={{
              marginBottom: '16px',
              borderRadius: '6px',
              border: '1px solid rgba(184, 88, 69, 0.3)',
              background: 'rgba(255, 245, 243, 0.9)'
            }}
          />
        )}

        {viewMode === 'visual' ? (
          <div>
            {serverNames.length === 0 ? (
              <div style={getMCPEmptyStateStyle()}>
                <Grid3x3 size={48} strokeWidth={1.5} style={{
                  color: 'rgba(139, 115, 85, 0.3)',
                  margin: '0 auto 16px'
                }} />
                <div style={{
                  fontSize: '14px',
                  color: MCP_COLORS.textSecondary,
                  marginBottom: '8px'
                }}>
                  {t('pages.mcpManager.noServers')}
                </div>
                <div style={{
                  fontSize: '13px',
                  color: 'rgba(45, 45, 45, 0.45)'
                }}>
                  {t('pages.mcpManager.noServersHint')}
                </div>
              </div>
            ) : (
              <Row gutter={[12, 12]}>
                {serverNames.map(serverName => (
                  <Col xs={24} lg={24} xl={12} key={serverName}>
                    <MCPServerCard
                      serverName={serverName}
                      config={config.mcpServers[serverName]}
                      status={status[serverName]}
                      onConnect={handleConnect}
                      onDisconnect={handleDisconnect}
                      onEdit={showEditModal}
                      onDelete={handleDeleteServer}
                      onViewTools={showToolsModal}
                      loading={loading}
                      currentUserId={currentUser?.user_id}
                      currentUserRole={currentUser?.role}
                    />
                  </Col>
                ))}
              </Row>
            )}
          </div>
        ) : (
          <MCPJsonEditor
            config={config}
            onSave={handleSaveJson}
            loading={loading}
          />
        )}

      <MCPServerForm
        visible={modalVisible}
        onClose={() => { formSession.current += 1; setModalVisible(false); }}
        onSubmit={handleFormSubmit}
        initialName={selectedServer}
        initialValues={initialValues}
        title={modalTitle}
      />

      <MCPToolsViewer
        visible={toolsModalVisible}
        onClose={() => setToolsModalVisible(false)}
        serverName={selectedServer}
      />
      </Content>
    </Layout>
  );
};

export default MCPManager;
