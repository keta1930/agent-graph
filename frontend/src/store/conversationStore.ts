import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { message } from 'antd';
import type { ConversationSummary, ConversationDetail, ConversationMode, SSEMessage } from '../types/conversation';
import { ConversationService, ConversationStorage } from '../services/conversationService';
import { assertSession, captureSession } from '../services/authSessionService';
import { createRequestScope } from '../services/requestLifecycle';
import { registerSessionReset, isCurrentSession } from '../utils/authSession';
import { getErrorMessage } from '../utils/errors';

export interface BatchMutationResult {
  succeededIds: string[];
  failed: { id: string; message: string }[];
}
interface ConversationState {
  conversations: ConversationSummary[];
  totalCount: number;
  loading: boolean;
  error: string | null;
  currentConversation: ConversationDetail | null;
  currentConversationLoading: boolean;
  currentMode: ConversationMode;
  searchQuery: string;
  statusFilter: 'active' | 'favorite' | 'deleted';
  typeFilter: 'agent' | 'graph';
  currentSSE: EventSource | null;
  isStreaming: boolean;
  sidebarCollapsed: boolean;
  loadConversations: (forceRefresh?: boolean) => Promise<void>;
  silentUpdateConversations: () => Promise<void>;
  loadConversationDetail: (conversationId: string) => Promise<void>;
  updateConversationStatus: (conversationId: string, status: 'active' | 'deleted' | 'favorite') => Promise<void>;
  updateConversationTitle: (conversationId: string, title: string) => Promise<void>;
  updateConversationTags: (conversationId: string, tags: string[]) => Promise<void>;
  deleteConversationPermanent: (conversationId: string) => Promise<void>;
  batchDeleteConversations: (conversationIds: string[], isPermanent: boolean, options?: { refresh?: boolean }) => Promise<BatchMutationResult>;
  setCurrentMode: (mode: ConversationMode) => void;
  clearCurrentConversation: () => void;
  updateCurrentConversationTemporarily: (conversation: ConversationDetail) => void;
  patchCurrentConversation: (conversationId: string, patch: Partial<ConversationDetail>) => void;
  startSSEConnection: (sse: EventSource) => void;
  stopSSEConnection: () => void;
  handleSSEMessage: (message: SSEMessage) => void;
  setSearchQuery: (query: string) => void;
  setStatusFilter: (filter: 'active' | 'favorite' | 'deleted') => void;
  setTypeFilter: (filter: 'agent' | 'graph') => void;
  toggleSidebar: () => void;
  showNotification: (message: string, type?: 'success' | 'error' | 'info') => void;
}
const listRequest = createRequestScope();
const detailRequest = createRequestScope();
let cacheUser: string | null = captureSession().userId;
function sidebarCollapsed(): boolean {
  try { return localStorage.getItem('sidebar_collapsed') === 'true'; } catch { return false; }
}
const initialState = () => ({
  conversations: [] as ConversationSummary[], totalCount: 0, loading: false, error: null,
  currentConversation: null, currentConversationLoading: false, currentMode: 'agent' as const,
  searchQuery: '', statusFilter: 'active' as const, typeFilter: 'agent' as const,
  currentSSE: null, isStreaming: false, sidebarCollapsed: sidebarCollapsed(),
});

export const useConversationStore = create<ConversationState>()(subscribeWithSelector((set, get) => {
  const loadList = (force: boolean, silent: boolean) => listRequest.run('all', async context => {
    cacheUser = context.userId;
    if (!force) {
      const cached = ConversationStorage.getCachedConversationList(context.userId);
      if (cached) { set({ conversations: cached.conversations, totalCount: cached.total_count }); return; }
    }
    if (!silent) set({ loading: true, error: null });
    try {
      const result = await ConversationService.getConversations({ signal: context.signal });
      if (!context.isCurrent()) return;
      let conversations = result.conversations;
      if (silent) {
        const byId = new Map(conversations.map(item => [item.conversation_id, item]));
        const oldIds = new Set(get().conversations.map(item => item.conversation_id));
        conversations = [
          ...conversations.filter(item => !oldIds.has(item.conversation_id)),
          ...get().conversations.flatMap(item => { const current = byId.get(item.conversation_id); return current ? [current] : []; }),
        ];
      }
      ConversationStorage.cacheConversationList(result, context.userId);
      set({ conversations, totalCount: result.total_count });
    } catch (error) {
      if (!context.isCurrent()) return;
      set({ error: getErrorMessage(error, '加载对话列表失败') });
      if (!silent) get().showNotification('加载对话列表失败', 'error');
    } finally { if (context.isCurrent()) set({ loading: false }); }
  });
  const mutate = async (operation: () => Promise<void>, apply: () => void) => {
    const session = captureSession();
    try {
      await operation();
      assertSession(session.generation);
      listRequest.invalidate();
      apply();
      ConversationStorage.clearConversationListCache(session.userId);
      await loadList(true, true);
    } catch (error) {
      if (isCurrentSession(session.generation)) set({ error: getErrorMessage(error) });
      throw error;
    }
  };
  return {
    ...initialState(),
    loadConversations: (forceRefresh = false) => loadList(forceRefresh, false),
    silentUpdateConversations: () => loadList(true, true),
    loadConversationDetail: conversationId => detailRequest.run(conversationId, async context => {
      cacheUser = context.userId;
      set({ currentConversationLoading: true, error: null });
      try {
        const detail = await ConversationService.getConversationDetail(conversationId, { signal: context.signal });
        if (!context.isCurrent()) return;
        ConversationStorage.setCurrentConversation(detail, context.userId);
        set({ currentConversation: detail, currentMode: detail.type });
      } catch (error) {
        if (!context.isCurrent()) return;
        set({ error: getErrorMessage(error, '加载对话详情失败') });
        get().showNotification('加载对话详情失败', 'error');
      } finally { if (context.isCurrent()) set({ currentConversationLoading: false }); }
    }),
    updateConversationStatus: (id, status) => mutate(() => ConversationService.updateConversationStatus(id, status), () => {
      set(state => ({ conversations: state.conversations.map(item => item.conversation_id === id ? { ...item, status } : item) }));
    }),
    updateConversationTitle: (id, title) => mutate(() => ConversationService.updateConversationTitle(id, title), () => {
      set(state => ({ conversations: state.conversations.map(item => item.conversation_id === id ? { ...item, title } : item) }));
      get().patchCurrentConversation(id, { title });
    }),
    updateConversationTags: (id, tags) => mutate(() => ConversationService.updateConversationTags(id, tags), () => {
      set(state => ({ conversations: state.conversations.map(item => item.conversation_id === id ? { ...item, tags } : item) }));
    }),
    deleteConversationPermanent: id => mutate(() => ConversationService.deleteConversationPermanent(id), () => {
      set(state => ({ conversations: state.conversations.filter(item => item.conversation_id !== id), totalCount: Math.max(0, state.totalCount - 1) }));
      if (get().currentConversation?.conversation_id === id) get().clearCurrentConversation();
    }),
    batchDeleteConversations: async (ids, permanent, options) => {
      const session = captureSession();
      const result: BatchMutationResult = { succeededIds: [], failed: [] };
      for (const id of new Set(ids)) {
        assertSession(session.generation);
        try {
          if (permanent) await ConversationService.deleteConversationPermanent(id);
          else await ConversationService.updateConversationStatus(id, 'deleted');
          assertSession(session.generation);
          result.succeededIds.push(id);
        } catch (error) {
          assertSession(session.generation);
          result.failed.push({ id, message: getErrorMessage(error) });
        }
      }
      assertSession(session.generation);
      if (result.succeededIds.length) {
        listRequest.invalidate();
        const removed = new Set(result.succeededIds);
        set(state => ({
          conversations: permanent ? state.conversations.filter(item => !removed.has(item.conversation_id)) : state.conversations.map(item => removed.has(item.conversation_id) ? { ...item, status: 'deleted' } : item),
          totalCount: permanent ? Math.max(0, state.totalCount - removed.size) : state.totalCount,
        }));
        const current = get().currentConversation;
        if (current && removed.has(current.conversation_id)) get().clearCurrentConversation();
        ConversationStorage.clearConversationListCache(session.userId);
        if (options?.refresh !== false) await loadList(true, true);
      }
      return result;
    },
    setCurrentMode: currentMode => set({ currentMode }),
    clearCurrentConversation: () => {
      detailRequest.invalidate();
      get().stopSSEConnection();
      ConversationStorage.clearCurrentConversation(captureSession().userId);
      set({ currentConversation: null, currentConversationLoading: false });
    },
    updateCurrentConversationTemporarily: currentConversation => {
      detailRequest.invalidate();
      set({ currentConversation, currentConversationLoading: false });
      ConversationStorage.setCurrentConversation(currentConversation, captureSession().userId);
    },
    patchCurrentConversation: (id, patch) => {
      const current = get().currentConversation;
      if (current?.conversation_id === id) get().updateCurrentConversationTemporarily({ ...current, ...patch, conversation_id: id });
    },
    startSSEConnection: currentSSE => { get().stopSSEConnection(); set({ currentSSE, isStreaming: true }); },
    stopSSEConnection: () => { get().currentSSE?.close(); set({ currentSSE: null, isStreaming: false }); },
    handleSSEMessage: event => {
      if (event.error) { get().showNotification(event.error.message, 'error'); get().stopSSEConnection(); }
      else if (event.completion) { get().showNotification(event.completion.message, 'success'); get().stopSSEConnection(); }
    },
    setSearchQuery: searchQuery => set({ searchQuery }),
    setStatusFilter: statusFilter => set({ statusFilter }),
    setTypeFilter: typeFilter => set({ typeFilter }),
    toggleSidebar: () => {
      const collapsed = !get().sidebarCollapsed;
      try { localStorage.setItem('sidebar_collapsed', String(collapsed)); } catch { /* UI 偏好不依赖存储成功。 */ }
      set({ sidebarCollapsed: collapsed });
    },
    showNotification: (text, type = 'info') => { void message[type](text); },
  };
}));
registerSessionReset(() => {
  listRequest.invalidate(); detailRequest.invalidate();
  useConversationStore.getState().currentSSE?.close();
  ConversationStorage.clearConversationListCache(cacheUser);
  ConversationStorage.clearCurrentConversation(cacheUser);
  useConversationStore.setState(initialState());
});
