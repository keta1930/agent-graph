import { StrictMode, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Link } from 'react-router-dom';
import { message } from 'antd';
import { beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { clearSession, commitSession } from './services/authSessionService';
import * as agentService from './services/agentService';
import * as modelService from './services/modelService';
import { getSessionGeneration } from './utils/authSession';
import { useAgentStore } from './store/agentStore';
import { useModelStore } from './store/modelStore';
import { useMCPStore } from './store/mcpStore';
import { useSystemToolsStore } from './store/systemToolsStore';
import { useTaskStore } from './store/taskStore';
import { useConversationStore } from './store/conversationStore';
import { useGraphEditorStore } from './store/graphEditorStore';
import type { ModelConfig } from './types/model';

vi.mock('./layouts/WorkspaceLayout', () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock('./pages/AgentManager', () => ({
  default: function AgentPage() {
    const agents = useAgentStore(state => state.agents);
    return <><h1>Private resources</h1><div>{agents.map(agent => agent.name).join(',')}</div><Link to="/share/public">Open share</Link></>;
  },
}));
vi.mock('./pages/SharedConversation', () => ({
  default: function SharePage() {
    const [draft, setDraft] = useState('');
    return <><h1>Public share</h1><input aria-label="Session draft" value={draft} onChange={event => setDraft(event.target.value)} /><Link to="/workspace/agent-manager">Return to private</Link></>;
  },
}));

const aliceAgent: agentService.AgentListItem = { name: 'alice-private-agent', category: 'private', tags: [], model: 'model', created_at: '', updated_at: '' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('app_locale', 'en');
  commitSession({ user_id: 'alice', role: 'normal', access_token: 'alice-token', refresh_token: 'refresh', token_type: 'bearer' });
  window.history.replaceState(null, '', '/workspace/agent-manager');
});

it('keeps one app storage subscription across public pages and resets all loaded stores and old requests for a new account', async () => {
  useAgentStore.setState({ agents: [aliceAgent] });
  useModelStore.setState({ models: [{ name: 'alice-model', model: 'model', base_url: 'https://example.test' }] });
  useMCPStore.setState({ version: 15, tools: { 'alice-server': [] } });
  useSystemToolsStore.setState({ systemTools: ['alice-tool'] });
  useTaskStore.setState({ queryParams: { graph_name: 'alice-graph' }, scheduledJobs: [{ id: 'alice-job', name: 'private', trigger: 'daily' }] });
  useConversationStore.setState({ currentConversation: { conversation_id: 'alice-chat', title: 'private', type: 'agent', rounds: [] }, searchQuery: 'alice-query' });
  useGraphEditorStore.getState().createNewGraph('alice-graph', 'private');
  useGraphEditorStore.getState().beginJsonEditing();
  useGraphEditorStore.getState().setJsonDraft('alice-unsaved-json');
  const agentPending = deferred<agentService.AgentListResponse>();
  const modelPending = deferred<ModelConfig[]>();
  const getAgents = vi.spyOn(agentService, 'listAllAgents').mockReturnValue(agentPending.promise);
  const getModels = vi.spyOn(modelService, 'getModels').mockReturnValue(modelPending.promise);
  const errorNotice = vi.spyOn(message, 'error');
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  const view = render(<StrictMode><App /></StrictMode>);
  expect(await screen.findByText('alice-private-agent')).toBeVisible();
  let requests: Promise<void>[] = [];
  await act(async () => {
    requests = [useAgentStore.getState().fetchAgents(), useModelStore.getState().fetchModels()];
  });
  fireEvent.click(screen.getByRole('link', { name: 'Open share' }));
  await screen.findByRole('heading', { name: 'Public share' });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'current session draft' } });
  const generation = getSessionGeneration();

  act(() => {
    localStorage.setItem('auth_token', 'alice-rotated-token');
    window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' }));
  });
  expect(getSessionGeneration()).toBe(generation);
  expect(screen.getByRole('textbox')).toHaveValue('current session draft');
  expect(useAgentStore.getState().agents).toEqual([aliceAgent]);

  act(() => {
    localStorage.setItem('auth_token', 'bob-token');
    localStorage.setItem('user_info', JSON.stringify({ user_id: 'bob', role: 'normal' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'user_info' }));
  });

  expect(getSessionGeneration()).toBe(generation + 1);
  expect(useAgentStore.getState()).toMatchObject({ agents: [], loading: false, error: undefined });
  expect(useModelStore.getState()).toMatchObject({ models: [], loading: false, error: undefined });
  expect(useMCPStore.getState()).toMatchObject({ config: { mcpServers: {} }, tools: {}, version: 1 });
  expect(useSystemToolsStore.getState().systemTools).toEqual([]);
  expect(useTaskStore.getState()).toMatchObject({ tasks: [], scheduledJobs: [], queryParams: { limit: 20, offset: 0 } });
  expect(useTaskStore.getState().queryParams.graph_name).toBeUndefined();
  expect(useConversationStore.getState()).toMatchObject({ currentConversation: null, conversations: [], searchQuery: '' });
  expect(useGraphEditorStore.getState()).toMatchObject({ currentGraph: null, graphs: [], jsonDraft: null, dirty: false });
  expect(getAgents.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(getModels.mock.calls[0][0]?.signal?.aborted).toBe(true);
  expect(await screen.findByRole('textbox')).toHaveValue('');

  await act(async () => {
    agentPending.resolve({ agents: [aliceAgent], total_count: 1 });
    modelPending.reject(new Error('Alice late request failure'));
    await Promise.all(requests);
  });
  expect(useAgentStore.getState().agents).toEqual([]);
  expect(useModelStore.getState().error).toBeUndefined();
  expect(errorNotice).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('link', { name: 'Return to private' }));
  expect(await screen.findByRole('heading', { name: 'Private resources' })).toBeVisible();
  expect(screen.queryByText('alice-private-agent')).not.toBeInTheDocument();

  view.unmount();
  const storageAdds = add.mock.calls.filter(([event]) => event === 'storage');
  const storageRemoves = remove.mock.calls.filter(([event]) => event === 'storage');
  expect(storageAdds).toHaveLength(2);
  expect(storageRemoves).toHaveLength(2);
  storageAdds.forEach((call, index) => expect(storageRemoves[index][1]).toBe(call[1]));
  localStorage.clear();
  window.dispatchEvent(new StorageEvent('storage', { key: null }));
  expect(getSessionGeneration()).toBe(generation + 1);
});

it('refreshes the storage identity after a local login so same-user token rotation preserves drafts', async () => {
  clearSession();
  window.history.replaceState(null, '', '/share/public');
  render(<StrictMode><App /></StrictMode>);
  await screen.findByRole('heading', { name: 'Public share' });
  act(() => commitSession({ user_id: 'bob', role: 'normal', access_token: 'bob-token', refresh_token: 'refresh', token_type: 'bearer' }));
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Bob draft' } });
  const generation = getSessionGeneration();

  act(() => {
    localStorage.setItem('auth_token', 'bob-rotated-token');
    window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' }));
  });

  expect(getSessionGeneration()).toBe(generation);
  expect(screen.getByRole('textbox')).toHaveValue('Bob draft');
});
