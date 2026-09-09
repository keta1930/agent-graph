// src/services/graphService.ts
import api from './api';
import { getSessionGeneration, isCurrentSession } from '../utils/authSession';
import { 
  BackendGraphConfig, 
  GraphCardResponse, 
  MCPScriptResponse,
  ImportResult,
  GraphMutationResponse,
  CreateVersionResponse,
  GraphVersionListResponse,
  GetVersionConfigResponse,
  GraphReadmeResponse,
  PromptTemplateResponse
} from '../types/graph';

import { parseGraphConfig } from '../utils/graphEditorModel';

// Get all graphs list
export const getGraphs = async (): Promise<string[]> => {
  const response = await api.get('/graphs');
  return response.data;
};

// Get a specific graph
export const getGraph = async (graphName: string): Promise<BackendGraphConfig> => {
  const response = await api.get(`/graphs/${encodeURIComponent(graphName)}`);
  return response.data;
};

// Create or update a graph
export const createGraph = async (graph: BackendGraphConfig): Promise<GraphMutationResponse> => {
  const requestBody = parseGraphConfig(graph);
  // 编辑器空值表示继承 Agent 上限；省略字段会触发后端默认值 50。
  requestBody.nodes = requestBody.nodes.map(node => ({
    ...node,
    max_iterations: node.max_iterations ?? null,
  }));
  const response = await api.post<GraphMutationResponse>('/graphs', requestBody);
  return response.data;
};

// Delete a graph
export const deleteGraph = async (graphName: string): Promise<GraphMutationResponse> => {
  const response = await api.delete(`/graphs/${encodeURIComponent(graphName)}`);
  return response.data;
};

// Rename a graph
export const renameGraph = async (oldName: string, newName: string): Promise<GraphMutationResponse> => {
  const response = await api.put(`/graphs/${encodeURIComponent(oldName)}/rename/${encodeURIComponent(newName)}`);
  return response.data;
};


// Get graph card
export const getGraphCard = async (graphName: string): Promise<GraphCardResponse> => {
  const response = await api.get(`/graphs/${encodeURIComponent(graphName)}/card`);
  return response.data;
};

// Generate MCP script
export const generateMCPScript = async (graphName: string): Promise<MCPScriptResponse> => {
  const response = await api.get(`/graphs/${encodeURIComponent(graphName)}/generate_mcp`);
  return response.data;
};

// Download MCP script as file
export const downloadMCPScript = async (graphName: string): Promise<void> => {
  const generation = getSessionGeneration();
  const response = await generateMCPScript(graphName);
  if (!isCurrentSession(generation)) throw new DOMException('Session changed', 'AbortError');
  
  if (response.error) {
    throw new Error(response.error);
  }

  // 使用 sequential_script 或 default_script
  const scriptContent = response.sequential_script || response.default_script || '';
  
  if (!scriptContent) {
    throw new Error('No script content available');
  }

  // 创建 Blob 并下载
  const blob = new Blob([scriptContent], { type: 'text/plain;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${graphName}_mcp_server.py`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
};

// ======= 导入导出功能 =======

// Import graph from JSON file (by file path)
export const importGraph = async (filePath: string): Promise<ImportResult> => {
  const response = await api.post('/graphs/import', { file_path: filePath });
  return response.data;
};

// Import graph from uploaded JSON file
export const importGraphFromFile = async (file: File): Promise<ImportResult> => {
  const formData = new FormData();
  formData.append('file', file);
  
  const response = await api.post('/graphs/import_from_file', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  });
  return response.data;
};

// Export graph to ZIP package
export const exportGraph = async (graphName: string): Promise<void> => {
  const generation = getSessionGeneration();
  const response = await api.get(`/graphs/${encodeURIComponent(graphName)}/export`, {
    responseType: 'blob'
  });
  if (!isCurrentSession(generation)) throw new DOMException('Session changed', 'AbortError');
  
  // 创建 Blob 并下载
  const blob = new Blob([response.data], { type: 'application/zip' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${graphName}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
};

// Import graph package from ZIP (by file path)
export const importGraphPackage = async (filePath: string): Promise<ImportResult> => {
  const response = await api.post('/graphs/import_package', { file_path: filePath });
  return response.data;
};

// Import graph package from uploaded ZIP file
export const importGraphPackageFromFile = async (file: File): Promise<ImportResult> => {
  const formData = new FormData();
  formData.append('file', file);
  
  const response = await api.post('/graphs/import_package_from_file', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  });
  return response.data;
};

// ======= AI提示词模板功能 =======

// Get prompt template for graph generation
export const getPromptTemplate = async (request?: { mcp_servers?: string[], graph_name?: string }): Promise<PromptTemplateResponse> => {
  const response = await api.post('/prompt-template', {
    mcp_servers: request?.mcp_servers || [],
    graph_name: request?.graph_name
  });
  return response.data;
};


// ======= README功能 =======

// Get graph README
export const getGraphReadme = async (graphName: string): Promise<GraphReadmeResponse> => {
  const response = await api.get(`/graphs/${encodeURIComponent(graphName)}/readme`);
  return response.data;
};

// ======= 版本管理功能 =======

/**
 * 创建图版本快照
 */
export const createGraphVersion = async (
  graphName: string,
  commitMessage: string
): Promise<CreateVersionResponse> => {
  const response = await api.post(`/graphs/${encodeURIComponent(graphName)}/create-version`, {
    commit_message: commitMessage
  });
  return response.data;
};

/**
 * 获取图的版本列表
 */
export const getGraphVersions = async (graphName: string): Promise<GraphVersionListResponse> => {
  const response = await api.get(`/graphs/${encodeURIComponent(graphName)}/versions`);
  return response.data;
};

/**
 * 获取特定版本的配置
 */
export const getGraphVersion = async (
  graphName: string,
  versionId: string
): Promise<GetVersionConfigResponse> => {
  const response = await api.get(`/graphs/${encodeURIComponent(graphName)}/versions/${encodeURIComponent(versionId)}`);
  return response.data;
};

/**
 * 删除特定版本
 */
export const deleteGraphVersion = async (
  graphName: string,
  versionId: string
): Promise<GraphMutationResponse> => {
  const response = await api.delete(`/graphs/${encodeURIComponent(graphName)}/versions/${encodeURIComponent(versionId)}`);
  return response.data;
};
