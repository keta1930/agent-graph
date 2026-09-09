// src/services/mcpService.ts
import api from './api';
import type { MCPConfig, MCPServerConfig, MCPConfigWithVersion, MCPStatus, MCPTools, MCPToolRegistration, MCPToolTestResult, MCPConfigUpdateResult, MCPServerMutationResult } from '../types/mcp';
import type { JsonObject } from '../types/json';

export const getMCPConfig = async (options: { signal?: AbortSignal } = {}): Promise<MCPConfigWithVersion> => {
  const response = await api.get<MCPConfigWithVersion>('/mcp/config', options);
  return response.data;
};

export const updateMCPConfig = async (config: MCPConfig, version: number) => {
  const response = await api.post<MCPConfigUpdateResult>('/mcp/config', {
    config,
    version
  });
  return response.data;
};

export const addMCPServer = async (serverName: string, serverConfig: MCPServerConfig, version: number) => {
  const response = await api.post<MCPServerMutationResult>('/mcp/add', {
    mcpServers: {
      [serverName]: serverConfig
    },
    version
  });
  return response.data;
};

export const removeMCPServers = async (serverNames: string[], version: number) => {
  const response = await api.post<MCPServerMutationResult>('/mcp/remove', {
    server_names: serverNames,
    version
  });
  return response.data;
};

export const getMCPStatus = async (options: { signal?: AbortSignal } = {}) => {
  const response = await api.get<MCPStatus>('/mcp/status', options);
  return response.data;
};

export const connectServer = async (serverName: string) => {
  const response = await api.post(`/mcp/connect/${encodeURIComponent(serverName)}`);
  return response.data;
};

export const disconnectServer = async (serverName: string) => {
  const response = await api.post(`/mcp/disconnect/${encodeURIComponent(serverName)}`);
  return response.data;
};

export const getMCPTools = async (options: { signal?: AbortSignal } = {}) => {
  const response = await api.get<MCPTools>('/mcp/tools', options);
  return response.data;
};

export const registerMCPTool = async (toolData: MCPToolRegistration) => {
  const response = await api.post('/mcp/register-tool', toolData);
  return response.data;
};

export const testMCPTool = async (serverName: string, toolName: string, params: JsonObject) => {
  const response = await api.post<MCPToolTestResult>('/mcp/test-tool', {
    server_name: serverName,
    tool_name: toolName,
    params
  });
  return response.data;
};
