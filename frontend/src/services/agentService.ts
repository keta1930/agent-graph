import api from './api';
import { collectPages } from '../utils/pagination';

// Agent 配置接口
export interface AgentConfig {
  name: string;
  card: string;
  model: string;
  instruction?: string;
  max_actions?: number;
  mcp?: string[];
  system_tools?: string[];
  category: string;
  tags?: string[];
}

export interface Agent {
  _id?: string;
  name: string;
  agent_config: AgentConfig;
  user_id: string;
  created_at: string;
  updated_at: string;
}

export interface AgentListItem {
  name: string;
  category: string;
  tags: string[];
  model: string;
  created_at: string;
  updated_at: string;
}

export interface AgentCategoryItem {
  category: string;
  agent_count: number;
}

export interface AgentInCategoryItem {
  name: string;
  tags: string[];
}

export interface AgentListResponse { agents: AgentListItem[]; total_count: number; }
export interface AgentCategoryResponse { success: boolean; categories: AgentCategoryItem[]; total_categories: number; }
export interface AgentInCategoryResponse { success: boolean; category: string; agents: AgentInCategoryItem[]; total_count: number; }
export interface AgentDetailResponse { status: string; agent: Agent; }
export interface AgentMutationResponse { status: string; message: string; agent_name?: string; agent_id?: string; }

// 列出 Agents
export const listAgents = async (category?: string, limit = 100, skip = 0, options: { signal?: AbortSignal } = {}) => {
  const params: { limit: number; skip: number; category?: string } = { limit, skip };
  if (category) params.category = category;

  const response = await api.get<AgentListResponse>('/agent/list', { params, ...options });
  return response.data;
};

export const listAllAgents = async (category?: string, options: { signal?: AbortSignal } = {}): Promise<AgentListResponse> => {
  const result = await collectPages(async (limit, skip) => {
    const page = await listAgents(category, limit, skip, options);
    return { items: page.agents, total_count: page.total_count };
  }, { pageSize: 100, keyOf: agent => agent.name, signal: options.signal });
  return { agents: result.items, total_count: result.total_count };
};

// 获取 Agent 分类列表
export const listCategories = async (options: { signal?: AbortSignal } = {}) => {
  const response = await api.get<AgentCategoryResponse>('/agent/categories', options);
  return response.data;
};

// 获取指定分类下的 Agents
export const listAgentsInCategory = async (category: string) => {
  const response = await api.get<AgentInCategoryResponse>(`/agent/category/${encodeURIComponent(category)}`);
  return response.data;
};

// 获取 Agent 配置
export const getAgent = async (agentName: string) => {
  const response = await api.get<AgentDetailResponse>(`/agent/${encodeURIComponent(agentName)}`);
  return response.data;
};

// 创建 Agent
export const createAgent = async (agentConfig: AgentConfig) => {
  const response = await api.post<AgentMutationResponse>('/agent', {
    agent_config: agentConfig
  });
  return response.data;
};

// 更新 Agent
export const updateAgent = async (
  agentName: string,
  agentConfig: AgentConfig
) => {
  const response = await api.put<AgentMutationResponse>(`/agent/${encodeURIComponent(agentName)}`, {
    agent_config: agentConfig
  });
  return response.data;
};

// 删除 Agent
export const deleteAgent = async (agentName: string) => {
  const response = await api.delete<AgentMutationResponse>(`/agent/${encodeURIComponent(agentName)}`);
  return response.data;
};

// 导入 Agents
export const importAgents = async (file: File) => {
  const formData = new FormData();
  formData.append('file', file);

  const response = await api.post('/agent/import', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
    responseType: 'blob', // 接收文件
  });

  // 创建下载链接
  const blob = new Blob([response.data], { type: 'text/markdown' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  
  // 从响应头获取文件名，如果没有则使用默认名称
  const contentDisposition = response.headers['content-disposition'];
  let filename = 'agent_import_report.md';
  if (contentDisposition) {
    const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (filenameMatch && filenameMatch[1]) {
      filename = filenameMatch[1].replace(/['"]/g, '');
    }
  }
  
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);

  return { success: true };
};
