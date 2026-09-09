import { beforeEach, expect, it, vi } from 'vitest';
import { useModelStore } from './modelStore';
import { useAgentStore } from './agentStore';
import { useSystemToolsStore } from './systemToolsStore';
import { useMCPStore } from './mcpStore';
import { useTaskStore } from './taskStore';
import * as models from '../services/modelService';
import * as agents from '../services/agentService';
import * as tools from '../services/systemToolsService';
import * as mcp from '../services/mcpService';
import { taskService } from '../services/taskService';
import { commitSession, clearSession } from '../services/authSessionService';
import { TaskStatus, type TaskSummary, type Task } from '../types/task';
import type { ModelConfig } from '../types/model';
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const model: ModelConfig = { name: 'model', model: 'test', base_url: 'https://example.test', api_key: 'key' };
beforeEach(() => { commitSession({ user_id: 'alice', role: 'user', access_token: 'a', refresh_token: 'r', token_type: 'bearer' }); });
it('deduplicates model reads and rejects a failed model mutation', async () => {
  const pending = deferred<ModelConfig[]>();
  const get = vi.spyOn(models, 'getModels').mockReturnValue(pending.promise);
  const first = useModelStore.getState().fetchModels(), second = useModelStore.getState().fetchModels();
  await Promise.resolve(); pending.resolve([model]); await Promise.all([first, second]);
  expect(get).toHaveBeenCalledOnce();
  vi.spyOn(models, 'addModel').mockRejectedValue(new Error('denied'));
  await expect(useModelStore.getState().addModel(model)).rejects.toThrow('denied');
  expect(useModelStore.getState().models).toEqual([model]);
});
it('resolves a saved model even if the follow-up list request fails', async () => {
  vi.spyOn(models, 'addModel').mockResolvedValue({});
  vi.spyOn(models, 'getModels').mockRejectedValue(new Error('refresh offline'));
  await expect(useModelStore.getState().addModel(model)).resolves.toBeUndefined();
  expect(useModelStore.getState().error).toBe('refresh offline');
  expect(useModelStore.getState().loading).toBe(false);
});
it('does not repopulate model data or errors after logout', async () => {
  const pending = deferred<ModelConfig[]>();
  vi.spyOn(models, 'getModels').mockReturnValue(pending.promise);
  const request = useModelStore.getState().fetchModels(); await Promise.resolve(); clearSession(); pending.resolve([model]); await request;
  expect(useModelStore.getState()).toMatchObject({ models: [], loading: false, error: undefined });
});
it('resets all resource stores synchronously without losing actions', () => {
  useAgentStore.setState({ agents: [{ name: 'a', category: 'c', tags: [], model: '', created_at: '', updated_at: '' }], loading: true, error: 'old' });
  useSystemToolsStore.setState({ systemTools: ['private'], loading: true });
  useMCPStore.setState({ version: 15, tools: { private: [] }, error: 'old' });
  useTaskStore.setState({ queryParams: { graph_name: 'private' }, error: 'old', loading: true });
  const fetch = useAgentStore.getState().fetchAgents;
  clearSession();
  expect(useAgentStore.getState()).toMatchObject({ agents: [], loading: false, error: undefined, fetchAgents: fetch });
  expect(useSystemToolsStore.getState().systemTools).toEqual([]);
  expect(useMCPStore.getState()).toMatchObject({ config: { mcpServers: {} }, version: 1, tools: {}, status: {} });
  expect(useTaskStore.getState()).toMatchObject({ queryParams: { limit: 20, offset: 0, sort_by: 'created_at', sort_order: 'desc' }, error: null, loading: false });
});
it('deduplicates agent/tool lists and rejects old-session failures without changing new state', async () => {
  const a = deferred<agents.AgentListResponse>(), t = deferred<tools.SystemToolListResponse>();
  const agentGet = vi.spyOn(agents, 'listAllAgents').mockReturnValue(a.promise);
  const toolGet = vi.spyOn(tools, 'listSystemTools').mockReturnValue(t.promise);
  const requests = [useAgentStore.getState().fetchAgents(), useAgentStore.getState().fetchAgents(), useSystemToolsStore.getState().fetchSystemTools(), useSystemToolsStore.getState().fetchSystemTools()];
  await Promise.resolve(); clearSession(); a.reject(new Error('late')); t.resolve({ success: true, categories: [], total_count: 0 }); await Promise.all(requests);
  expect(agentGet).toHaveBeenCalledOnce(); expect(toolGet).toHaveBeenCalledOnce();
  expect(useAgentStore.getState().error).toBeUndefined(); expect(useSystemToolsStore.getState().loading).toBe(false);
});
it('deduplicates MCP configuration requests separately from status/tools', async () => {
  const config = vi.spyOn(mcp, 'getMCPConfig').mockResolvedValue({ mcpServers: {}, version: 3 });
  const status = vi.spyOn(mcp, 'getMCPStatus').mockResolvedValue({});
  const tools = vi.spyOn(mcp, 'getMCPTools').mockResolvedValue({});
  await Promise.all([useMCPStore.getState().fetchConfig(), useMCPStore.getState().fetchConfig(), useMCPStore.getState().fetchStatus(), useMCPStore.getState().fetchTools()]);
  expect(config).toHaveBeenCalledOnce(); expect(status).toHaveBeenCalledOnce(); expect(tools).toHaveBeenCalledOnce();
  expect(useMCPStore.getState()).toMatchObject({ version: 3, loading: false });
});
it('rejects a MCP 200 response containing an explicit save error', async () => {
  vi.spyOn(mcp, 'updateMCPConfig').mockResolvedValue({ status: { error: 'storage unavailable' } });
  await expect(useMCPStore.getState().updateConfig({ mcpServers: {} })).rejects.toThrow('storage unavailable');
  expect(useMCPStore.getState().version).toBe(1);
});
it('does not apply a MCP version response after account change', async () => {
  const pending = deferred<{ status: { version: number } }>();
  vi.spyOn(mcp, 'updateMCPConfig').mockReturnValue(pending.promise);
  const update = useMCPStore.getState().updateConfig({ mcpServers: {} });
  clearSession(); pending.resolve({ status: { version: 99 } });
  await expect(update).rejects.toMatchObject({ name: 'AbortError' });
  expect(useMCPStore.getState().version).toBe(1);
});
it('ignores a stale task query and prevents its finally from clearing a later loading state', async () => {
  const a = deferred<TaskSummary[]>(), b = deferred<TaskSummary[]>();
  vi.spyOn(taskService, 'getTaskSummaries').mockImplementation(params => params?.offset === 10 ? b.promise : a.promise);
  const first = useTaskStore.getState().loadTasks(); await Promise.resolve();
  useTaskStore.getState().setQueryParams({ offset: 10 });
  const second = useTaskStore.getState().loadTasks(); await Promise.resolve();
  a.reject(new Error('stale')); await first;
  expect(useTaskStore.getState()).toMatchObject({ loading: true, error: null });
  b.resolve([]); await second;
  expect(useTaskStore.getState().loading).toBe(false);
});
it('clear task and query changes invalidate pending details', async () => {
  const pending = deferred<Task>();
  vi.spyOn(taskService, 'getTask').mockReturnValue(pending.promise);
  const request = useTaskStore.getState().loadTask('a'); await Promise.resolve();
  useTaskStore.getState().clearCurrentTask();
  expect(useTaskStore.getState().loading).toBe(false);
  pending.reject(new Error('late')); await request;
  expect(useTaskStore.getState()).toMatchObject({ currentTask: null, error: null, loading: false });
});
it('rejects failed task mutations and preserves a successful task result when refresh fails', async () => {
  vi.spyOn(taskService, 'updateTaskStatus').mockResolvedValue({ status: 'error', message: 'denied' });
  await expect(useTaskStore.getState().updateTaskStatus('id', TaskStatus.PAUSED)).rejects.toThrow('denied');
  vi.spyOn(taskService, 'reloadScheduler').mockResolvedValue({ status: 'success', message: 'done' });
  vi.spyOn(taskService, 'getScheduledJobs').mockRejectedValue(new Error('refresh failed'));
  await expect(useTaskStore.getState().reloadScheduler()).resolves.toBe(true);
  expect(useTaskStore.getState().error).toBe('refresh failed');
});
