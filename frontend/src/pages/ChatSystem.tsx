import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { Button, Dropdown, Tooltip, App, Spin } from 'antd';
import { CompressOutlined, DownOutlined, FileOutlined } from '@ant-design/icons';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import ConversationSidebar from '../components/chat/sidebar/ConversationSidebar';
import ModeSelector from '../components/chat/input/ModeSelector';
import MessageDisplay from '../components/chat/message/MessageDisplay';
import InputArea from '../components/chat/input/InputArea';
import CompactConfigModal from '../components/chat/modal/CompactConfigModal';
import GlobalNotification from '../components/common/GlobalNotification';
import { DocumentsDrawer } from '../components/chat/drawer';
import { FileViewModal } from '../components/conversation-file/FileViewModal';
import { useConversationStore } from '../store/conversationStore';
import { useSSEConnection } from '../hooks/useSSEConnection';
import { useT } from '../i18n/hooks';
import { useGlobalNotification } from '../hooks/useGlobalNotification';
import { ConversationService, generateMongoId } from '../services/conversationService';
import type { ChatInputConfig, ChatSubmitOptions, ConversationMode, ConversationDetail, InputConfig } from '../types/conversation';
import { getSessionGeneration, isCurrentSession } from '../utils/authSession';
import { getErrorMessage } from '../utils/errors';
import ShareButton from '../components/chat/ShareButton';
import ShareModal from '../components/chat/ShareModal';
import { useTour, chatTourSteps } from '../components/tour';
import '../components/tour/tour-custom.css';
import '../styles/chat-system.css';

function inputConfig(options: ChatSubmitOptions): InputConfig {
  return {
    selected_model: options.model_name, selected_graph: options.graph_name, system_prompt: options.system_prompt,
    selected_mcp_servers: options.mcp_servers ?? [], selected_agent: options.agent_name ?? null,
    selected_system_tools: options.system_tools ?? [], max_iterations: options.max_iterations ?? null
  };
}
function inheritedInput(config?: InputConfig): ChatInputConfig {
  return {
    selectedModel: config?.selected_model, selectedGraph: config?.selected_graph, systemPrompt: config?.system_prompt,
    selectedMCPServers: config?.selected_mcp_servers ?? [], selectedAgent: config?.selected_agent,
    selectedSystemTools: config?.selected_system_tools ?? [], maxIterations: config?.max_iterations
  };
}

const ChatSystem: React.FC = () => {
  const { conversationId: activeConversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const t = useT();
  const { message } = App.useApp();
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null);
  const [temporaryConversation, setTemporaryConversation] = useState<ConversationDetail | null>(null);
  const [selectedGraphName, setSelectedGraphName] = useState('');
  const [inheritedConfig, setInheritedConfig] = useState<ChatInputConfig>({});
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const submissionRef = useRef<symbol | null>(null);
  const [compactConfigVisible, setCompactConfigVisible] = useState(false);
  const [selectedCompactType, setSelectedCompactType] = useState<'brutal' | 'precise'>('precise');
  const [compactingConversations, setCompactingConversations] = useState<Set<string>>(new Set());
  const [documentsDrawerVisible, setDocumentsDrawerVisible] = useState(false);
  const [fileViewModalVisible, setFileViewModalVisible] = useState(false);
  const [selectedFilename, setSelectedFilename] = useState<string | null>(null);
  const [shareModalVisible, setShareModalVisible] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [shareId, setShareId] = useState('');
  const [shareLoading, setShareLoading] = useState(false);
  const currentConversation = useConversationStore(state => state.currentConversation);
  const currentConversationLoading = useConversationStore(state => state.currentConversationLoading);
  const currentMode = useConversationStore(state => state.currentMode);
  const loadConversationDetail = useConversationStore(state => state.loadConversationDetail);
  const clearCurrentConversation = useConversationStore(state => state.clearCurrentConversation);
  const setCurrentMode = useConversationStore(state => state.setCurrentMode);
  const silentUpdateConversations = useConversationStore(state => state.silentUpdateConversations);
  const patchCurrentConversation = useConversationStore(state => state.patchCurrentConversation);
  const { streamingState, enhancedStreamingState, startConnection, closeConnection, resetStreamingState } = useSSEConnection();
  const { notifications, removeNotification, success: showSuccessNotification } = useGlobalNotification();
  const selectionRef = useRef<{ id?: string; session: number }>({ id: activeConversationId, session: getSessionGeneration() });
  const expectedNavigationRef = useRef<{ submission: symbol; ids: Set<string> } | null>(null);
  const initializedConfigRef = useRef<string | undefined>(undefined);
  // history 已更新时 React 路由可能仍在过渡；接管前输入会随会话 key 重建。
  const routeAdoptionPending = expectedNavigationRef.current !== null && selectionRef.current.id !== activeConversationId;
  const displayConversationId = routeAdoptionPending ? selectionRef.current.id : activeConversationId;
  const mountedRef = useRef(true);
  const captureOwnership = useCallback(() => {
    const selection = selectionRef.current;
    return () => mountedRef.current && selectionRef.current === selection && isCurrentSession(selection.session);
  }, []);

  const { startTour } = useTour({
    steps: chatTourSteps,
    onComplete: () => { try { localStorage.setItem('chat-tour-completed', 'true'); } catch { /* 引导完成不依赖存储可用性。 */ } }
  });
  useEffect(() => {
    let completed = false;
    try { completed = localStorage.getItem('chat-tour-completed') === 'true'; } catch { /* 存储不可用时保留引导。 */ }
    if (completed) return;
    const timer = setTimeout(startTour, 1000);
    return () => clearTimeout(timer);
  }, [startTour]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // URL 切换统一使旧回调失效；服务端新建 ID 的确认属于同一次执行。
  useLayoutEffect(() => {
    const expected = expectedNavigationRef.current;
    // 停止生成使旧提交失效，但不撤销已经请求的同会话路由接管。
    if (activeConversationId && expected && (expected.submission === submissionRef.current || submissionRef.current === null) && isCurrentSession(selectionRef.current.session) && expected.ids.delete(activeConversationId)) {
      if (activeConversationId === selectionRef.current.id) expectedNavigationRef.current = null;
      return;
    }
    expectedNavigationRef.current = null;
    selectionRef.current = { id: activeConversationId, session: getSessionGeneration() };
    startingRef.current = false;
    submissionRef.current = null;
    initializedConfigRef.current = undefined;
    closeConnection();
    resetStreamingState();
    clearCurrentConversation();
    setStarting(false);
    setPendingUserMessage(null);
    setTemporaryConversation(null);
    setSelectedGraphName('');
    setInheritedConfig({});
    setCompactConfigVisible(false);
    setDocumentsDrawerVisible(false);
    setFileViewModalVisible(false);
    setSelectedFilename(null);
    setShareModalVisible(false);
    setShareLoading(false);
    setCompactingConversations(new Set());
    if (activeConversationId) void loadConversationDetail(activeConversationId);
    else setCurrentMode('agent');
  }, [activeConversationId, location.key, clearCurrentConversation, closeConnection, loadConversationDetail, resetStreamingState, setCurrentMode]);

  useEffect(() => {
    if (!activeConversationId || currentConversation?.conversation_id !== activeConversationId || temporaryConversation) return;
    setCurrentMode(currentConversation.type);
    if (initializedConfigRef.current !== activeConversationId) {
      initializedConfigRef.current = activeConversationId;
      setInheritedConfig(inheritedInput(currentConversation.input_config));
      setSelectedGraphName(currentConversation.input_config?.selected_graph ?? '');
    }
  }, [activeConversationId, currentConversation, setCurrentMode, temporaryConversation]);

  const getDisplayConversation = useCallback(() => {
    if (temporaryConversation?.conversation_id === displayConversationId) return temporaryConversation;
    return currentConversation?.conversation_id === displayConversationId ? currentConversation : null;
  }, [displayConversationId, currentConversation, temporaryConversation]);
  const cancelSubmissionForNavigation = useCallback(() => {
    submissionRef.current = null;
    expectedNavigationRef.current = null;
    closeConnection();
  }, [closeConnection]);
  const handleConversationSelect = useCallback((id: string) => {
    if (id === activeConversationId) return;
    cancelSubmissionForNavigation();
    navigate(`/chat/${id}`);
  }, [activeConversationId, cancelSubmissionForNavigation, navigate]);
  const handleNewConversation = useCallback(() => {
    cancelSubmissionForNavigation();
    navigate('/chat');
  }, [cancelSubmissionForNavigation, navigate]);
  const handleModeSelect = useCallback((mode: ConversationMode) => { setCurrentMode(mode); }, [setCurrentMode]);

  const submit = useCallback(async (text: string, options: ChatSubmitOptions = {}, isNew = false) => {
    if (startingRef.current || streamingState.isStreaming || (expectedNavigationRef.current && selectionRef.current.id !== activeConversationId)) return;
    const ownsSelection = captureOwnership();
    const submission = Symbol();
    submissionRef.current = submission;
    expectedNavigationRef.current = null;
    const owns = () => ownsSelection() && submissionRef.current === submission;
    const selection = selectionRef.current;
    let targetId = isNew ? generateMongoId() : activeConversationId;
    if (!targetId) return;
    const mode = options.mode ?? currentMode;
    const config = inputConfig(options);
    startingRef.current = true;
    setStarting(true);
    const adoptId = (id: string) => {
      targetId = id;
      selection.id = id;
      // 临时 URL 尚未提交时可能收到真实 ID，两次接管都属于当前提交。
      if (expectedNavigationRef.current?.submission !== submission) {
        expectedNavigationRef.current = { submission, ids: new Set() };
      }
      expectedNavigationRef.current.ids.add(id);
      initializedConfigRef.current = id;
      navigate(`/chat/${id}`, { replace: true });
    };
    try {
      await startConnection(text, {
        ...options, mode, conversationId: isNew && mode === 'graph' ? undefined : targetId,
        onOpen: () => {
          if (!owns()) return;
          setPendingUserMessage(text);
          if (!isNew && targetId) patchCurrentConversation(targetId, {});
          if (isNew && targetId) {
            clearCurrentConversation();
            setTemporaryConversation({ conversation_id: targetId, title: t('pages.chatSystem.newConversation'), rounds: [], type: mode });
            setInheritedConfig(inheritedInput(config));
            setSelectedGraphName(options.graph_name ?? '');
            adoptId(targetId);
          }
        },
        onConversationCreated: id => {
          if (!owns() || !isNew || mode !== 'graph') return;
          adoptId(id);
          setTemporaryConversation(previous => previous ? { ...previous, conversation_id: id } : previous);
        },
        onTitleUpdate: data => {
          if (!owns() || !targetId || (data.conversation_id && data.conversation_id !== targetId)) return;
          if (data.title) {
            const title = data.title;
            patchCurrentConversation(targetId, { title });
            setTemporaryConversation(previous => previous && previous.conversation_id === targetId ? { ...previous, title } : previous);
          }
          void silentUpdateConversations();
        },
        onComplete: async () => {
          if (!owns() || !targetId) return;
          const completedId = targetId;
          try { await ConversationService.updateInputConfig(completedId, config); }
          catch (error) { if (owns()) message.warning(getErrorMessage(error, t('pages.chatSystem.errors.saveConfigFailed'))); }
          if (!owns()) return;
          await loadConversationDetail(completedId);
          if (!owns()) return;
          if (useConversationStore.getState().currentConversation?.conversation_id === completedId && !useConversationStore.getState().error) {
            setPendingUserMessage(null);
            setTemporaryConversation(null);
            resetStreamingState();
          }
          void silentUpdateConversations();
        },
        onError: error => { if (owns()) message.error(`${t('pages.chatSystem.errors.connectionError')}: ${error}`); }
      });
    } finally {
      if (owns()) { startingRef.current = false; setStarting(false); }
    }
  }, [activeConversationId, captureOwnership, clearCurrentConversation, currentMode, loadConversationDetail, message, navigate, patchCurrentConversation, resetStreamingState, silentUpdateConversations, startConnection, streamingState.isStreaming, t]);
  const handleStartConversation = useCallback((text: string, options?: ChatSubmitOptions) => submit(text, options, true), [submit]);
  const handleSendMessage = useCallback((text: string, options?: ChatSubmitOptions) => submit(text, options, !activeConversationId), [activeConversationId, submit]);

  const handleCompactTypeSelect = useCallback((compactType: 'brutal' | 'precise') => {
    if (!activeConversationId || !getDisplayConversation()) { message.error(t('pages.chatSystem.errors.noConversationSelected')); return; }
    setSelectedCompactType(compactType); setCompactConfigVisible(true);
  }, [activeConversationId, getDisplayConversation, message, t]);
  const handleCompactConfirm = useCallback(async (config: { modelName: string; compactType: 'brutal' | 'precise'; threshold: number }) => {
    const conversation = getDisplayConversation();
    if (!activeConversationId || !conversation) return;
    const id = activeConversationId;
    const owns = captureOwnership();
    setCompactConfigVisible(false);
    setCompactingConversations(previous => new Set(previous).add(id));
    try {
      const result = await ConversationService.compactConversation(id, config.modelName, config.compactType, config.threshold);
      if (!owns()) return;
      if (result.status !== 'success') { message.error(result.message || t('pages.chatSystem.errors.compactFailed')); return; }
      showSuccessNotification(t('pages.chatSystem.messages.compactComplete', { title: conversation.title }), undefined, 4000);
      await loadConversationDetail(id);
      if (owns()) setTemporaryConversation(null);
    } catch (error) { if (owns()) message.error(getErrorMessage(error, t('pages.chatSystem.errors.compactConversationFailed'))); }
    finally { if (owns()) setCompactingConversations(previous => { const next = new Set(previous); next.delete(id); return next; }); }
  }, [activeConversationId, captureOwnership, getDisplayConversation, loadConversationDetail, message, showSuccessNotification, t]);

  const handleShareClick = useCallback(async () => {
    if (!activeConversationId || shareLoading) return;
    const owns = captureOwnership();
    setShareLoading(true);
    try {
      const status = await ConversationService.getShareStatus(activeConversationId);
      if (!owns()) return;
      let id = status.share_info?.share_id;
      if (!status.is_shared || !id) {
        const response = await ConversationService.createShare(activeConversationId);
        if (!owns()) return;
        id = response.share_id;
        message.success(t('pages.chatSystem.share.createSuccess'));
      }
      setShareUrl(`${window.location.origin}/share/${id}`); setShareId(id); setShareModalVisible(true);
    } catch (error) { if (owns()) message.error(getErrorMessage(error, t('pages.chatSystem.share.shareFailed'))); }
    finally { if (owns()) setShareLoading(false); }
  }, [activeConversationId, captureOwnership, message, shareLoading, t]);
  const handleDeleteShare = useCallback(async () => {
    if (!shareId) return;
    const owns = captureOwnership();
    await ConversationService.deleteShare(shareId);
    if (!owns()) return;
    setShareModalVisible(false); setShareUrl(''); setShareId('');
  }, [captureOwnership, shareId]);

  const displayConversation = getDisplayConversation();
  const getDisplayTitle = () => displayConversation?.title || (pendingUserMessage ? t('pages.chatSystem.newConversation') : '');
  const getMainAreaStyle = () => 'main-conversation-area';

  return (
    <div className="chat-system-page">
      <div className="chat-system-layout">
        {/* 左侧边栏 */}
        <div data-tour="chat-sidebar">
          <ConversationSidebar
            onConversationSelect={handleConversationSelect}
            onNewConversation={handleNewConversation}
            activeConversationId={activeConversationId}
          />
        </div>

        {/* 主对话区域 */}
        <div className={getMainAreaStyle()} data-tour="chat-main-area">
          {streamingState.isStreaming && <Button onClick={() => {
            submissionRef.current = null;
            startingRef.current = false;
            setStarting(false);
            closeConnection();
          }}>{t('pages.chatSystem.stopGeneration')}</Button>}
          {activeConversationId && !displayConversation && !pendingUserMessage ? (
            <div role="status" style={{ padding: 32 }}><Spin spinning={currentConversationLoading} />{currentConversationLoading ? t('common.loading') : t('pages.chatSystem.errors.noConversationSelected')}</div>
          ) : !displayConversation && !pendingUserMessage ? (
            /* 无对话且无待发送消息时显示模式选择器 */
            <ModeSelector
              disabled={starting || streamingState.isStreaming || routeAdoptionPending}
              onModeSelect={handleModeSelect}
              onStartConversation={handleStartConversation}
            />
          ) : (
            /* 有对话时显示消息和输入区域 */
            <>
              {/* 对话头部 */}
              <div style={{
                padding: '20px 32px',
                background: 'linear-gradient(to bottom, rgba(250, 248, 245, 0.95), rgba(245, 243, 240, 0.9))',
                borderBottom: '1px solid rgba(139, 115, 85, 0.15)',
                boxShadow: '0 2px 8px rgba(139, 115, 85, 0.06), inset 0 -1px 0 rgba(255, 255, 255, 0.6)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                position: 'relative'
              }}>
                {/* 装饰性纸张纹理 */}
                <div style={{
                  position: 'absolute',
                  bottom: 0,
                  left: '15%',
                  right: '15%',
                  height: '1px',
                  background: 'linear-gradient(to right, transparent, rgba(139, 115, 85, 0.2) 50%, transparent)'
                }} />

                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px'
                }}>
                  <span style={{
                    fontSize: '16px',
                    fontWeight: 500,
                    color: '#2d2d2d',
                    letterSpacing: '0.5px'
                  }}>
                    {getDisplayTitle()}
                  </span>
                  {/* Graph模式显示选择的图名称 */}
                  {currentMode === 'graph' && selectedGraphName && (
                    <span style={{
                      fontSize: '14px',
                      color: 'rgba(45, 45, 45, 0.65)',
                      fontWeight: 'normal'
                    }}>
                      {' - '}
                      <span style={{ color: '#a0826d' }}>
                        {selectedGraphName}
                      </span>
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {/* Documents 按钮 */}
                  {displayConversation && (
                    <Tooltip title={t('pages.chatSystem.viewDocuments')}>
                      <Button
                        type="text"
                        icon={<FileOutlined />}
                        size="small"
                        onClick={() => setDocumentsDrawerVisible(true)}
                        style={{
                          color: '#8b7355',
                          border: '1px solid rgba(139, 115, 85, 0.2)',
                          borderRadius: '6px',
                          background: 'rgba(255, 255, 255, 0.6)',
                          padding: '4px 12px',
                          fontSize: '13px',
                          fontWeight: 500,
                          transition: 'all 0.2s ease'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.color = '#a0826d';
                          e.currentTarget.style.borderColor = 'rgba(160, 130, 109, 0.3)';
                          e.currentTarget.style.background = 'rgba(160, 130, 109, 0.05)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.color = '#8b7355';
                          e.currentTarget.style.borderColor = 'rgba(139, 115, 85, 0.2)';
                          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.6)';
                        }}
                      >
                        {t('pages.chatSystem.documents')}: {displayConversation.documents?.total_count || 0}
                      </Button>
                    </Tooltip>
                  )}

                  {/* 分享按钮 */}
                  {displayConversation && (
                    <ShareButton
                      onClick={handleShareClick}
                      loading={shareLoading}
                      disabled={shareLoading}
                    />
                  )}
                  
                  {/* 压缩按钮 - 支持所有对话类型 */}
                  {displayConversation && (() => {
                    const isCurrentConversationCompacting = activeConversationId ? compactingConversations.has(activeConversationId) : false;
                    return (
                      <Dropdown
                        menu={{
                          onClick: ({ key }) => { if (key === 'brutal' || key === 'precise') handleCompactTypeSelect(key); },
                          items: [
                            { key: 'precise', label: <div><div>{t('pages.chatSystem.compact.preciseCompact')}</div><div style={{ fontSize: 12, color: 'rgba(45, 45, 45, 0.65)' }}>{t('pages.chatSystem.compact.preciseCompactDesc')}</div></div> },
                            { key: 'brutal', label: <div><div>{t('pages.chatSystem.compact.brutalCompact')}</div><div style={{ fontSize: 12, color: 'rgba(45, 45, 45, 0.65)' }}>{t('pages.chatSystem.compact.brutalCompactDesc')}</div></div> }
                          ]
                        }}
                        trigger={['click']}
                        placement="bottomRight"
                        disabled={isCurrentConversationCompacting}
                      >
                        <Tooltip title={isCurrentConversationCompacting ? t('pages.chatSystem.compact.compacting') : t('pages.chatSystem.compact.compactConversation')}>
                          <Button
                            type="text"
                            icon={<CompressOutlined />}
                            size="small"
                            loading={isCurrentConversationCompacting}
                            disabled={isCurrentConversationCompacting}
                            style={{
                              color: isCurrentConversationCompacting ? 'rgba(45, 45, 45, 0.45)' : '#8b7355',
                              border: '1px solid rgba(139, 115, 85, 0.2)',
                              borderRadius: '6px',
                              background: 'rgba(255, 255, 255, 0.6)',
                              padding: '4px 12px',
                              fontSize: '13px',
                              fontWeight: 500,
                              transition: 'all 0.2s ease'
                            }}
                            onMouseEnter={(e) => {
                              if (!isCurrentConversationCompacting) {
                                e.currentTarget.style.color = '#b85845';
                                e.currentTarget.style.borderColor = 'rgba(184, 88, 69, 0.3)';
                                e.currentTarget.style.background = 'rgba(184, 88, 69, 0.05)';
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (!isCurrentConversationCompacting) {
                                e.currentTarget.style.color = '#8b7355';
                                e.currentTarget.style.borderColor = 'rgba(139, 115, 85, 0.2)';
                                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.6)';
                              }
                            }}
                          >
                            {isCurrentConversationCompacting ? t('pages.chatSystem.compact.compacting') : t('pages.chatSystem.compact.compact')} <DownOutlined />
                          </Button>
                        </Tooltip>
                      </Dropdown>
                    );
                  })()}
                </div>
              </div>

              {/* 消息显示区域 */}
              <MessageDisplay
                key={displayConversation?.conversation_id || 'new'}
                conversation={displayConversation || {
                  conversation_id: activeConversationId || '',
                  title: t('pages.chatSystem.newConversation'),
                  rounds: [],
                  type: currentMode === 'graph' ? 'graph' : 'agent'
                }}
                enhancedStreamingState={enhancedStreamingState}
                pendingUserMessage={pendingUserMessage}
                currentMode={currentMode}
              />

              {/* 输入区域 */}
              <InputArea
                conversationId={activeConversationId}
                onSendMessage={handleSendMessage}
                disabled={starting || streamingState.isStreaming || routeAdoptionPending || (activeConversationId ? compactingConversations.has(activeConversationId) : false)}
                mode={currentMode}
                inheritedConfig={initializedConfigRef.current === activeConversationId ? inheritedConfig : inheritedInput(displayConversation?.input_config)}
              />
            </>
          )}
        </div>

        {/* 压缩配置对话框 */}
        <CompactConfigModal
          visible={compactConfigVisible}
          compactType={selectedCompactType}
          onConfirm={handleCompactConfirm}
          onCancel={() => setCompactConfigVisible(false)}
        />

        {/* 全局通知 */}
        <GlobalNotification
          notifications={notifications}
          onRemove={removeNotification}
        />

        {/* Documents 抽屉 */}
        {displayConversation && activeConversationId && (
          <DocumentsDrawer
            visible={documentsDrawerVisible}
            conversationId={activeConversationId}
            documents={displayConversation.documents}
            onClose={() => setDocumentsDrawerVisible(false)}
            onDocumentClick={(filename) => {
              setSelectedFilename(filename);
              setFileViewModalVisible(true);
            }}
          />
        )}

        {/* 文件查看模态框 */}
        {activeConversationId && (
          <FileViewModal
            visible={fileViewModalVisible}
            filename={selectedFilename}
            resourceId={activeConversationId}
            onClose={() => {
              setFileViewModalVisible(false);
              setSelectedFilename(null);
            }}
            onSave={() => {
              // 文件保存后重新加载对话详情以更新文档列表
              loadConversationDetail(activeConversationId);
            }}
            onDelete={() => {
              // 文件删除后重新加载对话详情以更新文档列表
              loadConversationDetail(activeConversationId);
            }}
          />
        )}

        {/* 分享对话框 */}
        <ShareModal
          visible={shareModalVisible}
          shareUrl={shareUrl}
          shareId={shareId}
          onClose={() => setShareModalVisible(false)}
          onDelete={handleDeleteShare}
        />

      </div>
    </div>
  );
};

export default ChatSystem;
