import axios from 'axios';
import { create } from 'zustand';
import type { MCPConfig, MCPServerConfig, MCPStatus, MCPTools, MCPToolRegistration, MCPToolTestResult } from '../types/mcp';
import type { JsonObject } from '../types/json';
import * as mcpService from '../services/mcpService';
import { createRequestScope, type RequestContext } from '../services/requestLifecycle';
import { assertSession, captureSession } from '../services/authSessionService';
import { isCurrentSession, registerSessionReset } from '../utils/authSession';
import { getErrorMessage } from '../utils/errors';
interface MCPState {
  config: MCPConfig;
  // 读取失败保留上次权威配置；初始空值只有成功读取后才具有删除语义。
  configLoaded: boolean;
  version: number;
  status: MCPStatus;
  tools: MCPTools;
  loading: boolean;
  error?: string;
  fetchConfig: () => Promise<void>;
  updateConfig: (config: MCPConfig) => Promise<void>;
  fetchStatus: () => Promise<void>;
  connectServer: (serverName: string) => Promise<void>;
  disconnectServer: (serverName: string) => Promise<void>;
  fetchTools: () => Promise<void>;
  connectAllServers: () => Promise<{ success: string[]; failed: string[] }>;
  addServer: (serverName: string, serverConfig: MCPServerConfig) => Promise<void>;
  updateServer: (serverName: string, serverConfig: MCPServerConfig) => Promise<void>;
  deleteServer: (serverName: string) => Promise<void>;
  registerMCPTool: (toolData: MCPToolRegistration) => Promise<void>;
  testTool: (serverName: string, toolName: string, params: JsonObject) => Promise<MCPToolTestResult>;
  getUsedPorts: () => number[];
}
export class MCPVersionConflictError extends Error {
  readonly isVersionConflict = true;
  constructor(message: string, readonly currentVersion?: number, readonly expectedVersion?: number) { super(message); }
}
const configRequest = createRequestScope(), statusRequest = createRequestScope(), toolsRequest = createRequestScope();
const busy = new Set<symbol>();
const initialState = () => ({ config: { mcpServers: {} }, configLoaded: false, version: 1, status: {}, tools: {}, loading: false, error: undefined });
export const useMCPStore = create<MCPState>((set, get) => {
  const begin = (signal?: AbortSignal) => {
    const { generation } = captureSession();
    const token = Symbol(); busy.add(token); set({ loading: true, error: undefined });
    const finish = () => {
      signal?.removeEventListener('abort', finish);
      if (isCurrentSession(generation) && busy.delete(token)) set({ loading: busy.size > 0 });
    };
    signal?.addEventListener('abort', finish, { once: true });
    return finish;
  };
  const read = async (context: RequestContext, operation: () => Promise<Partial<MCPState>>) => {
    const finish = begin(context.signal);
    try { const state = await operation(); if (context.isCurrent()) set(state); }
    catch (error) { if (context.isCurrent()) set({ error: getErrorMessage(error) }); }
    finally { finish(); }
  };
  const mutate = async (operation: () => Promise<void>, refresh?: () => Promise<void>) => {
    const { generation } = captureSession(); const finish = begin();
    configRequest.invalidate();
    try {
      await operation(); assertSession(generation);
      configRequest.invalidate();
      if (refresh) await refresh();
    } catch (error) {
      assertSession(generation);
      if (axios.isAxiosError<{ detail?: { message?: string; current_version?: number; expected_version?: number } }>(error) && error.response?.status === 409) {
        await get().fetchConfig(); assertSession(generation);
        const detail = error.response.data.detail;
        const conflict = new MCPVersionConflictError(detail?.message ?? '配置已被其他用户修改，请刷新页面查看最新配置后再保存', detail?.current_version, detail?.expected_version);
        set({ error: conflict.message }); throw conflict;
      }
      set({ error: getErrorMessage(error) }); throw error;
    } finally { finish(); }
  };
  return {
    ...initialState(),
    fetchConfig: () => configRequest.run('config', context => read(context, async () => {
      const data = await mcpService.getMCPConfig({ signal: context.signal });
      return { config: { mcpServers: data.mcpServers }, configLoaded: true, version: data.version };
    })),
    fetchStatus: () => statusRequest.run('status', context => read(context, async () => ({ status: await mcpService.getMCPStatus({ signal: context.signal }) }))),
    fetchTools: () => toolsRequest.run('tools', context => read(context, async () => ({ tools: await mcpService.getMCPTools({ signal: context.signal }) }))),
    updateConfig: config => {
      const generation = captureSession().generation;
      const version = get().version;
      return mutate(async () => {
        const result = await mcpService.updateMCPConfig(config, version);
        assertSession(generation);
        if (result.status.error) throw new Error(result.status.error);
        set({ config, configLoaded: true, version: result.status.version ?? version });
      });
    },
    connectServer: name => mutate(async () => { await mcpService.connectServer(name); }, async () => { statusRequest.invalidate(); await get().fetchStatus(); }),
    disconnectServer: name => mutate(async () => { await mcpService.disconnectServer(name); }, async () => { statusRequest.invalidate(); await get().fetchStatus(); }),
    connectAllServers: async () => {
      const { generation } = captureSession(); const finish = begin();
      const results = { success: [] as string[], failed: [] as string[] };
      try {
        const enabled = Object.keys(get().config.mcpServers).filter(name => !get().config.mcpServers[name].disabled && !get().status[name]?.connected);
        for (const name of enabled) {
          assertSession(generation);
          try { await mcpService.connectServer(name); assertSession(generation); results.success.push(name); }
          catch { assertSession(generation); results.failed.push(name); }
        }
        assertSession(generation); statusRequest.invalidate(); await get().fetchStatus(); return results;
      } finally { finish(); }
    },
    addServer: (name, config) => mutate(async () => {
      const result = await mcpService.addMCPServer(name, config, get().version);
      if (result.status !== 'success') throw new Error(result.message ?? result.error ?? 'Failed to add server');
    }, () => get().fetchConfig()),
    updateServer: (name, server) => get().updateConfig({ mcpServers: { ...get().config.mcpServers, [name]: server } }),
    deleteServer: name => mutate(async () => {
      const result = await mcpService.removeMCPServers([name], get().version);
      if (result.status !== 'success') throw new Error(result.message ?? result.error ?? 'Failed to delete server');
    }, () => get().fetchConfig()),
    registerMCPTool: tool => mutate(async () => { await mcpService.registerMCPTool(tool); }, async () => {
      statusRequest.invalidate(); await Promise.all([get().fetchConfig(), get().fetchStatus()]);
    }),
    testTool: (server, tool, params) => mcpService.testMCPTool(server, tool, params),
    getUsedPorts: () => {
      const ports = Object.values(get().config.mcpServers).flatMap(server => {
        if (!server.url) return [];
        try { const port = new URL(server.url).port; return port ? [Number(port)] : []; } catch { return []; }
      });
      return [...new Set(ports)].sort((a, b) => a - b);
    },
  };
});
registerSessionReset(() => { configRequest.invalidate(); statusRequest.invalidate(); toolsRequest.invalidate(); busy.clear(); useMCPStore.setState(initialState()); });
