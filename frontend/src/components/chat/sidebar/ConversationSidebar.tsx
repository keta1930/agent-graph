// src/components/chat/sidebar/ConversationSidebar.tsx
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Input, Button, Empty, Spin, Tooltip } from 'antd';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, Home, Clock, ChevronLeft, CheckSquare } from 'lucide-react';
import { useConversationStore } from '../../../store/conversationStore';
import { getSessionGeneration, isCurrentSession } from '../../../utils/authSession';
import { getErrorMessage } from '../../../utils/errors';
import { useT } from '../../../i18n/hooks';
import UserMenu from '../../common/UserMenu';
import CollapsedSidebar from './CollapsedSidebar';
import ConversationItem from './ConversationItem';
import ExportManagerButton from '../modal/ExportManagerButton';
import './ConversationSidebar.css';

interface ConversationSidebarProps {
  onConversationSelect: (conversationId: string) => void;
  onNewConversation?: () => void;
  activeConversationId?: string;
  onUserNameUpdate?: () => void;
}

const ConversationSidebar: React.FC<ConversationSidebarProps> = ({
  onConversationSelect,
  onNewConversation,
  activeConversationId,
}) => {
  const navigate = useNavigate();
  const t = useT();
  const scrollPosition = useRef(0);
  const deletingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [selectedConversations, setSelectedConversations] = useState<
    Set<string>
  >(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const currentSelectionRef = useRef({ activeConversationId, onNewConversation });
  const mountedRef = useRef(false);
  useEffect(() => {
    currentSelectionRef.current = { activeConversationId, onNewConversation };
  }, [activeConversationId, onNewConversation]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const handleConversationDeleted = useCallback((conversationId: string) => {
    const current = currentSelectionRef.current;
    if (mountedRef.current && current.activeConversationId === conversationId) current.onNewConversation?.();
  }, []);

  const conversations = useConversationStore(state => state.conversations);
  const loading = useConversationStore(state => state.loading);
  const searchQuery = useConversationStore(state => state.searchQuery);
  const sidebarCollapsed = useConversationStore(state => state.sidebarCollapsed);
  const setSearchQuery = useConversationStore(state => state.setSearchQuery);
  const toggleSidebar = useConversationStore(state => state.toggleSidebar);
  const loadConversations = useConversationStore(state => state.loadConversations);
  const silentUpdateConversations = useConversationStore(state => state.silentUpdateConversations);
  const showNotification = useConversationStore(state => state.showNotification);
  const batchDeleteConversations = useConversationStore(state => state.batchDeleteConversations);

  useEffect(() => {
    void loadConversations();
    const refresh = () => {
      scrollPosition.current = listRef.current?.scrollTop ?? 0;
      void silentUpdateConversations();
    };
    let visible = !document.hidden;
    let interval = visible ? setInterval(refresh, 15000) : undefined;
    const handleVisibility = () => {
      const nextVisible = !document.hidden;
      if (visible === nextVisible) return;
      visible = nextVisible;
      clearInterval(interval);
      interval = undefined;
      if (visible) {
        // 恢复时立即刷新，同一列表正在读取时由 store 合并请求。
        refresh();
        interval = setInterval(refresh, 15000);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', handleVisibility); };
  }, [loadConversations, silentUpdateConversations]);
  useEffect(() => {
    if (loading || !conversations.length) return;
    const frame = requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = scrollPosition.current; });
    return () => cancelAnimationFrame(frame);
  }, [conversations, loading]);

  const visibleConversations = useMemo(() => {
    const filtered = conversations.filter((conv) => {
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return (
          conv.title.toLowerCase().includes(query) ||
          conv.tags.some((tag) => tag.toLowerCase().includes(query))
        );
      }
      return true;
    });

    return filtered.sort((a, b) => {
      const ta = new Date(a.created_at).getTime() || 0;
      const tb = new Date(b.created_at).getTime() || 0;
      return tb - ta;
    });
  }, [conversations, searchQuery]);

  const selectedIds = useMemo(() => new Set(conversations.filter(item => selectedConversations.has(item.conversation_id)).map(item => item.conversation_id)), [conversations, selectedConversations]);
  const allVisibleSelected = visibleConversations.length > 0 && visibleConversations.every(item => selectedIds.has(item.conversation_id));

  const handleBatchModeToggle = () => {
    if (deletingRef.current) return;
    setIsBatchMode(!isBatchMode);
    setSelectedConversations(new Set());
  };

  const handleConversationSelect = useCallback((
    conversationId: string,
    selected: boolean
  ) => {
    if (deletingRef.current) return;
    setSelectedConversations(previous => {
      const next = new Set(previous);
      if (selected) next.add(conversationId);
      else next.delete(conversationId);
      return next;
    });
  }, []);

  const handleSelectAll = () => {
    const allIds = new Set(visibleConversations.map((conv) => conv.conversation_id));
    setSelectedConversations(allIds);
  };

  const handleDeselectAll = () => {
    setSelectedConversations(new Set());
  };

  const handleBatchDelete = async () => {
    if (!selectedIds.size || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    const session = getSessionGeneration();
    const selectedList = conversations.filter(item => selectedIds.has(item.conversation_id));
    const groups = [
      { permanent: false, ids: selectedList.filter(item => item.status !== 'deleted').map(item => item.conversation_id) },
      { permanent: true, ids: selectedList.filter(item => item.status === 'deleted').map(item => item.conversation_id) }
    ];
    const succeeded = new Set<string>();
    const summaries: string[] = [];
    let failed = 0;
    try {
      for (const group of groups) {
        if (!group.ids.length) continue;
        try {
          const result = await batchDeleteConversations(group.ids, group.permanent, { refresh: false });
          if (!isCurrentSession(session) || !mountedRef.current) return;
          result.succeededIds.forEach(id => succeeded.add(id));
          failed += result.failed.length;
          if (result.succeededIds.length) summaries.push(t(group.permanent ? 'components.conversationSidebar.permanentlyDeleted' : 'components.conversationSidebar.movedToTrash', { count: result.succeededIds.length }));
          if (result.failed.length) summaries.push(t(group.permanent ? 'components.conversationSidebar.permanentDeleteFailed' : 'components.conversationSidebar.softDeleteFailed', { count: result.failed.length }));
        } catch {
          if (!isCurrentSession(session) || !mountedRef.current) return;
          failed += group.ids.length;
          summaries.push(t(group.permanent ? 'components.conversationSidebar.permanentDeleteFailed' : 'components.conversationSidebar.softDeleteFailed', { count: group.ids.length }));
        }
      }
      if (!isCurrentSession(session) || !mountedRef.current) return;
      setSelectedConversations(previous => new Set([...previous].filter(id => !succeeded.has(id))));
      if (!failed) setIsBatchMode(false);
      succeeded.forEach(handleConversationDeleted);
      if (succeeded.size) {
        try { await silentUpdateConversations(); }
        catch (error) {
          failed += 1;
          summaries.push(getErrorMessage(error, t('components.conversationSidebar.batchDeleteFailed')));
        }
      }
      if (isCurrentSession(session) && mountedRef.current && summaries.length) showNotification(summaries.join(' · '), failed ? 'error' : 'success');
    } finally {
      deletingRef.current = false;
      if (isCurrentSession(session) && mountedRef.current) setDeleting(false);
    }
  };

  if (sidebarCollapsed) {
    return (
      <CollapsedSidebar
        onExpand={toggleSidebar}
        onNewConversation={onNewConversation}
      />
    );
  }

  return (
    <div
      style={{
        width: '280px',
        height: '100vh',
        background: 'linear-gradient(to bottom, #faf8f5 0%, #f5f3f0 100%)',
        borderRight: '1px solid rgba(139, 115, 85, 0.12)',
        boxShadow: '2px 0 8px rgba(139, 115, 85, 0.06)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 0.4s cubic-bezier(0.23, 1, 0.32, 1)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* 头部 */}
      <div
        style={{
          padding: '24px 20px',
          borderBottom: '1px solid rgba(139, 115, 85, 0.08)',
          background: 'rgba(255, 255, 255, 0.5)',
          position: 'relative',
        }}
      >
        {/* Header decorative line */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: '20%',
            right: '20%',
            height: '1px',
            background: 'linear-gradient(to right, transparent, rgba(139, 115, 85, 0.25) 50%, transparent)',
          }}
        />
        {/* 搜索框和收起按钮 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '12px',
          }}
        >
          <Input
            prefix={
              <Search
                size={16}
                strokeWidth={1.5}
                style={{ color: 'rgba(45, 45, 45, 0.45)' }}
              />
            }
            placeholder={t('components.conversationSidebar.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            allowClear
            style={{
              flex: 1,
              height: '36px',
              borderRadius: '6px',
              border: '1px solid rgba(139, 115, 85, 0.15)',
              background: '#ffffff',
              fontSize: '14px',
            }}
          />
          <Button
            type="text"
            icon={<ChevronLeft size={16} strokeWidth={1.5} />}
            onClick={toggleSidebar}
            style={{
              height: '36px',
              width: '36px',
              borderRadius: '6px',
              border: 'none',
              background: 'transparent',
              color: '#8b7355',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(139, 115, 85, 0.08)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          />
        </div>

        {/* 功能按钮行：批量选择、导出、任务中心、新对话 */}
        <div style={{ display: 'flex', gap: '4px', justifyContent: 'space-between' }}>
          {/* 批量选择按钮 */}
          <Tooltip title={isBatchMode ? t('components.conversationSidebar.cancelSelection') : t('components.conversationSidebar.batchMode')}>
            <Button
              type="text"
              icon={<CheckSquare size={16} strokeWidth={1.5} />}
              onClick={handleBatchModeToggle}
              disabled={deleting}
              style={{
                height: '36px',
                width: '36px',
                borderRadius: '6px',
                border: 'none',
                background: isBatchMode ? 'rgba(139, 115, 85, 0.08)' : 'transparent',
                color: isBatchMode ? '#8b7355' : 'rgba(45, 45, 45, 0.65)',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(139, 115, 85, 0.08)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = isBatchMode ? 'rgba(139, 115, 85, 0.08)' : 'transparent';
              }}
            />
          </Tooltip>

          {/* 导出按钮 */}
          <ExportManagerButton />

          {/* 任务中心按钮 */}
          <Tooltip title={t('components.conversationSidebar.taskCenter')}>
            <Button
              type="text"
              icon={<Clock size={16} strokeWidth={1.5} />}
              onClick={() => navigate('/tasks')}
              style={{
                height: '36px',
                width: '36px',
                borderRadius: '6px',
                border: 'none',
                background: 'transparent',
                color: 'rgba(45, 45, 45, 0.65)',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(139, 115, 85, 0.08)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            />
          </Tooltip>

          {/* 新对话按钮 - 小图标，放在最右边 */}
          {onNewConversation && (
            <Tooltip title={t('components.conversationSidebar.newConversation')}>
              <Button
                type="text"
                icon={<Plus size={16} strokeWidth={1.5} />}
                onClick={onNewConversation}
                data-tour="chat-new-conversation"
                style={{
                  height: '36px',
                  width: '36px',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'transparent',
                  color: 'rgba(45, 45, 45, 0.65)',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(139, 115, 85, 0.08)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              />
            </Tooltip>
          )}
        </div>
      </div>

      {/* 批量操作工具栏 */}
      {isBatchMode && (
        <div
          style={{
            padding: '12px 16px',
            background: 'rgba(139, 115, 85, 0.03)',
            borderBottom: '1px solid rgba(139, 115, 85, 0.08)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div
            style={{
              fontSize: '13px',
              color: 'rgba(45, 45, 45, 0.65)',
              fontWeight: 400,
            }}
          >
            {t('components.conversationSidebar.selectedCount', { count: selectedIds.size })}
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Button
              type="text"
              size="small"
              onClick={handleSelectAll}
              disabled={deleting || visibleConversations.length === 0 || allVisibleSelected}
              style={{
                fontSize: '12px',
                height: '24px',
                padding: '0 8px',
                color: '#8b7355',
                border: 'none',
              }}
            >
              {t('components.conversationSidebar.selectAll')}
            </Button>
            <Button
              type="text"
              size="small"
              onClick={handleDeselectAll}
              disabled={deleting || selectedIds.size === 0}
              style={{
                fontSize: '12px',
                height: '24px',
                padding: '0 8px',
                color: '#8b7355',
                border: 'none',
              }}
            >
              {t('components.conversationSidebar.deselectAll')}
            </Button>
            <div
              style={{
                width: '1px',
                height: '14px',
                background: 'rgba(139, 115, 85, 0.15)',
              }}
            />
            <Button
              type="text"
              size="small"
              onClick={handleBatchDelete}
              loading={deleting}
              disabled={selectedIds.size === 0}
              style={{
                fontSize: '12px',
                height: '24px',
                padding: '0 8px',
                color: '#b85845',
                border: 'none',
              }}
            >
              {t('common.delete')}
            </Button>
          </div>
        </div>
      )}

      {/* 对话列表 */}
      <div
        ref={listRef}
        onScroll={event => { scrollPosition.current = event.currentTarget.scrollTop; }}
        className="conversation-list-scrollbar"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px',
          // 滚动条样式
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(139, 115, 85, 0.25) transparent',
        }}
      >
        {loading ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              height: '200px',
            }}
          >
            <Spin size="large" />
          </div>
        ) : visibleConversations.length === 0 ? (
          <Empty
            description={searchQuery ? t('components.conversationSidebar.noMatchingConversations') : t('components.conversationSidebar.noConversations')}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{
              padding: '40px 20px',
            }}
          />
        ) : (
          visibleConversations.map((conversation) => (
            <ConversationItem
              key={conversation.conversation_id}
              conversation={conversation}
              isActive={conversation.conversation_id === activeConversationId}
              onClick={() => onConversationSelect(conversation.conversation_id)}
              isBatchMode={isBatchMode}
              isSelected={selectedIds.has(conversation.conversation_id)}
              onSelect={handleConversationSelect}
              selectionDisabled={deleting}
              onDeleted={handleConversationDeleted}
            />
          ))
        )}
      </div>

      {/* 底部 - 用户头像和回到主页 */}
      <div
        style={{
          padding: '20px 16px',
          borderTop: '1px solid rgba(139, 115, 85, 0.08)',
          background: 'rgba(255, 255, 255, 0.5)',
          display: 'flex',
          flexDirection: 'row',
          gap: '8px',
          justifyContent: 'center',
          alignItems: 'center',
          position: 'relative',
        }}
      >
        {/* Footer decorative line */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: '20%',
            right: '20%',
            height: '1px',
            background: 'linear-gradient(to right, transparent, rgba(139, 115, 85, 0.25) 50%, transparent)',
          }}
        />
        {/* 用户头像下拉菜单 */}
        <UserMenu collapsed={false} placement="topLeft" />

        {/* 前往工作台按钮 */}
        <Tooltip title={t('components.conversationSidebar.goToWorkspace')}>
          <Button
            type="text"
            icon={<Home size={16} strokeWidth={1.5} />}
            onClick={() => navigate('/workspace')}
            data-tour="chat-workspace-button"
            style={{
              color: 'rgba(45, 45, 45, 0.65)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(139, 115, 85, 0.08)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          />
        </Tooltip>
      </div>
    </div>
  );
};

export default ConversationSidebar;
