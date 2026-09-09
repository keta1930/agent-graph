// src/services/conversationService.ts
import api from './api';
import { collectPages } from '../utils/pagination';
import { getToken } from '../utils/auth';
import { getSessionGeneration } from '../utils/authSession';
import { assertSession, clearSession, refreshAccessToken } from './authSessionService';
import { getErrorMessage } from '../utils/errors';
import type { JsonObject } from '../types/json';
import {
  ConversationListResponse,
  ConversationDetail,
  GraphExecuteRequest,
  AgentRunRequest,
  CreateShareResponse,
  ShareStatusResponse,
  DeleteShareResponse,
  SharedConversationResponse
} from '../types/conversation';

const CONVERSATION_API_BASE = '/conversations';

export class ConversationService {
  // 单页保留服务端总数，完整列表供本地搜索、全选和缓存使用。
  static async getConversationPage(limit = 200, skip = 0, options: { signal?: AbortSignal } = {}): Promise<ConversationListResponse> {
    const response = await api.get<ConversationListResponse>(`${CONVERSATION_API_BASE}`, { params: { limit, skip }, ...options });
    return response.data;
  }

  static async getConversations(options: { signal?: AbortSignal } = {}): Promise<ConversationListResponse> {
    const result = await collectPages(async (limit, skip) => {
      const page = await this.getConversationPage(limit, skip, options);
      return { items: page.conversations, total_count: page.total_count };
    }, { pageSize: 200, keyOf: conversation => conversation.conversation_id, signal: options.signal });
    return { conversations: result.items, total_count: result.total_count };
  }

  // 获取对话详情
  static async getConversationDetail(conversationId: string, options: { signal?: AbortSignal } = {}): Promise<ConversationDetail> {
    const response = await api.get<ConversationDetail>(`${CONVERSATION_API_BASE}/${encodeURIComponent(conversationId)}`, options);
    return response.data;
  }

  // 更新对话状态
  static async updateConversationStatus(
    conversationId: string,
    status: 'active' | 'deleted' | 'favorite'
  ): Promise<void> {
    await api.put(`${CONVERSATION_API_BASE}/${encodeURIComponent(conversationId)}/status`, {
      status
    });
  }

  // 更新对话标题
  static async updateConversationTitle(
    conversationId: string,
    title: string
  ): Promise<void> {
    await api.put(`${CONVERSATION_API_BASE}/${encodeURIComponent(conversationId)}/title`, {
      title
    });
  }

  // 更新对话标签
  static async updateConversationTags(
    conversationId: string,
    tags: string[]
  ): Promise<void> {
    await api.put(`${CONVERSATION_API_BASE}/${encodeURIComponent(conversationId)}/tags`, {
      tags
    });
  }

  // 更新输入配置
  static async updateInputConfig(
    conversationId: string,
    inputConfig: {
      selected_model?: string;
      selected_graph?: string;
      system_prompt?: string;
      selected_mcp_servers?: string[];
      selected_agent?: string | null;
      selected_system_tools?: string[];
      max_iterations?: number | null;
    }
  ): Promise<void> {
    await api.put(`${CONVERSATION_API_BASE}/${encodeURIComponent(conversationId)}/input-config`, {
      input_config: inputConfig
    });
  }

  // 永久删除对话
  static async deleteConversationPermanent(
    conversationId: string
  ): Promise<void> {
    await api.delete(`${CONVERSATION_API_BASE}/${encodeURIComponent(conversationId)}/permanent`);
  }

  // 压缩对话
  static async compactConversation(
    conversationId: string,
    modelName: string,
    compactType: 'brutal' | 'precise' = 'precise',
    compactThreshold: number = 2000
  ): Promise<{ status: string; message: string; conversation_id: string; compact_type: string; statistics?: JsonObject; error?: string }> {
    const response = await api.post(`${CONVERSATION_API_BASE}/${encodeURIComponent(conversationId)}/compact`, {
      conversation_id: conversationId,
      model_name: modelName,
      compact_type: compactType,
      compact_threshold: compactThreshold
    });
    return response.data;
  }



  static async createGraphSSE(request: GraphExecuteRequest, options: { signal?: AbortSignal } = {}): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    return openStream('/graphs/execute', JSON.stringify(request), options.signal, true);
  }

  static async createAgentRunSSE(request: AgentRunRequest, options: { signal?: AbortSignal } = {}): Promise<ReadableStreamDefaultReader<Uint8Array>> {
      const formData = new FormData();

      // 必需参数
      formData.append('user_prompt', request.user_prompt);
      formData.append('stream', String(request.stream ?? true));

      // 可选参数
      if (request.agent_name) {
        formData.append('agent_name', request.agent_name);
      }
      if (request.conversation_id) {
        formData.append('conversation_id', request.conversation_id);
      }
      if (request.project_id) {
        formData.append('project_id', request.project_id);
      }
      if (request.model_name) {
        formData.append('model_name', request.model_name);
      }
      if (request.system_prompt) {
        formData.append('system_prompt', request.system_prompt);
      }
      if (request.mcp_servers && request.mcp_servers.length > 0) {
        formData.append('mcp_servers', JSON.stringify(request.mcp_servers));
      }
      if (request.system_tools && request.system_tools.length > 0) {
        formData.append('system_tools', JSON.stringify(request.system_tools));
      }
      if (request.max_iterations !== undefined) {
        formData.append('max_iterations', String(request.max_iterations));
      }

      // 文件上传（新增）
      if (request.files && request.files.length > 0) {
        request.files.forEach(file => {
          formData.append('files', file);
        });
      }

    return openStream('/agent/run', formData, options.signal);
  }

  // 分享相关API
  // 创建分享链接
  static async createShare(conversationId: string): Promise<CreateShareResponse> {
    const response = await api.post(`${CONVERSATION_API_BASE}/${encodeURIComponent(conversationId)}/share`);
    return response.data;
  }

  // 查询分享状态
  static async getShareStatus(conversationId: string, options: { signal?: AbortSignal } = {}): Promise<ShareStatusResponse> {
    const response = await api.get<ShareStatusResponse>(`${CONVERSATION_API_BASE}/${encodeURIComponent(conversationId)}/share/status`, options);
    return response.data;
  }

  // 删除分享
  static async deleteShare(shareId: string): Promise<DeleteShareResponse> {
    const response = await api.delete(`/share/${encodeURIComponent(shareId)}`);
    return response.data;
  }

  // 获取分享的对话（无需认证）
  static async getSharedConversation(shareId: string, options: { signal?: AbortSignal } = {}): Promise<SharedConversationResponse> {
    const response = await api.get<SharedConversationResponse>(`/share/${encodeURIComponent(shareId)}`, options);
    return response.data;
  }

  // 获取分享的文件列表（无需认证）
  static async getSharedFiles(shareId: string, options: { signal?: AbortSignal } = {}): Promise<string[]> {
    const response = await api.get<{ files: string[] }>(`/share/${encodeURIComponent(shareId)}/files`, options);
    return response.data.files; // 后端返回 {success, files, total_count}
  }

  // 下载分享的单个文件（无需认证）
  static async downloadSharedFile(shareId: string, filename: string): Promise<Blob> {
    const response = await api.get(`/share/${encodeURIComponent(shareId)}/file/${encodeURIComponent(filename)}`, {
      responseType: 'blob'
    });
    return response.data;
  }

  // 批量下载分享的所有文件（无需认证）
  static async downloadAllSharedFiles(shareId: string): Promise<Blob> {
    const response = await api.get(`/share/${encodeURIComponent(shareId)}/batch`, {
      responseType: 'blob'
    });
    return response.data;
  }
}

// 工具函数：生成MongoDB格式的ID
export function generateMongoId(): string {
  const timestamp = Math.floor(Date.now() / 1000).toString(16);
  const randomHex = Math.random().toString(16).substring(2, 18);
  return (timestamp + randomHex).padEnd(24, '0').substring(0, 24);
}

async function openStream(path: string, body: BodyInit, signal?: AbortSignal, json = false): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const generation = getSessionGeneration();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertSession(generation, signal);
    const token = getToken();
    const headers: Record<string, string> = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
    if (json) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch('/api' + path, { method: 'POST', headers, body, signal });
    try { assertSession(generation, signal); } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (response.status === 401 && attempt === 0) {
      await response.body?.cancel().catch(() => undefined);
      if (!getToken() || getToken() === token) await refreshAccessToken(generation, signal);
      continue;
    }
    if (!response.ok) {
      let payload: unknown;
      try { payload = await response.json(); } catch { /* 非 JSON 错误响应保留 HTTP 状态。 */ }
      assertSession(generation, signal);
      if (response.status === 401) clearSession();
      throw new Error(getErrorMessage(payload, 'HTTP ' + response.status + ': ' + response.statusText));
    }
    if (!response.body) throw new Error('Response body is null');
    return response.body.getReader();
  }
  throw new Error('Stream authentication failed');
}

// 缓存只接受发起请求时捕获的用户；浏览器存储失败不影响网络结果。
export class ConversationStorage {
  private static readonly CACHE_DURATION = 5 * 60 * 1000;
  private static key(resource: string, userId: string): string { return resource + ':v2:' + encodeURIComponent(userId); }
  static removeLegacyCaches(): void {
    try { localStorage.removeItem('conversations_cache'); } catch { /* 缓存可选。 */ }
    try { sessionStorage.removeItem('current_conversation'); } catch { /* 缓存可选。 */ }
  }
  static cacheConversationList(data: ConversationListResponse, userId: string | null): void {
    if (!userId) return;
    try { localStorage.setItem(this.key('conversations_cache', userId), JSON.stringify({ timestamp: Date.now(), data })); } catch { /* 缓存可选。 */ }
  }
  static getCachedConversationList(userId: string | null): ConversationListResponse | null {
    this.removeLegacyCaches();
    if (!userId) return null;
    try {
      const cached: unknown = JSON.parse(localStorage.getItem(this.key('conversations_cache', userId)) ?? 'null');
      if (!cached || typeof cached !== 'object' || !('timestamp' in cached) || !('data' in cached)) return null;
      if (typeof cached.timestamp !== 'number' || Date.now() - cached.timestamp > this.CACHE_DURATION) return null;
      const data = cached.data;
      if (!data || typeof data !== 'object' || !('conversations' in data) || !('total_count' in data)) return null;
      if (!Array.isArray(data.conversations) || typeof data.total_count !== 'number') return null;
      if (!data.conversations.every(value => value && typeof value === 'object' && typeof value.conversation_id === 'string' && value.user_id === userId)) return null;
      return data as ConversationListResponse;
    } catch { return null; }
  }
  static clearConversationListCache(userId: string | null): void {
    if (!userId) return;
    try { localStorage.removeItem(this.key('conversations_cache', userId)); } catch { /* 缓存可选。 */ }
  }
  static setCurrentConversation(conversation: ConversationDetail, userId: string | null): void {
    if (!userId) return;
    try { sessionStorage.setItem(this.key('current_conversation', userId), JSON.stringify(conversation)); } catch { /* 缓存可选。 */ }
  }
  static getCurrentConversation(userId: string | null): ConversationDetail | null {
    this.removeLegacyCaches();
    if (!userId) return null;
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(this.key('current_conversation', userId)) ?? 'null');
      if (!stored || typeof stored !== 'object' || !('conversation_id' in stored) || !('rounds' in stored) || !('type' in stored)) return null;
      if (typeof stored.conversation_id !== 'string' || !Array.isArray(stored.rounds) || (stored.type !== 'agent' && stored.type !== 'graph')) return null;
      return stored as ConversationDetail;
    } catch { return null; }
  }
  static clearCurrentConversation(userId: string | null): void {
    if (!userId) return;
    try { sessionStorage.removeItem(this.key('current_conversation', userId)); } catch { /* 缓存可选。 */ }
  }
}
ConversationStorage.removeLegacyCaches();
