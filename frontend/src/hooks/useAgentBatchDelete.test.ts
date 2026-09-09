import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useAgentManager } from './useAgentManager';
import { useAgentBatchDelete } from './useAgentBatchDelete';

const mocks = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(), confirm: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('../i18n/hooks', () => { const t = (key: string) => key; return { useT: () => t }; });
vi.mock('antd', () => {
  const message = { success: mocks.success, warning: mocks.warning, error: mocks.error };
  return { App: { useApp: () => ({ modal: { confirm: mocks.confirm }, message }) }, message };
});
vi.mock('../services/agentService', () => ({ listAllAgents: mocks.list, deleteAgent: mocks.remove, createAgent: vi.fn(), updateAgent: vi.fn(), getAgent: vi.fn(), listCategories: async () => ({ categories: [] }) }));
vi.mock('../services/modelService', () => ({ getModels: async () => [] }));
vi.mock('../services/systemToolsService', () => ({ listSystemTools: async () => ({ categories: [] }) }));
vi.mock('../services/mcpService', () => ({ getMCPConfig: async () => ({ mcpServers: {} }) }));

it('counts actual deletes, refreshes once, and retains only failed selections', async () => {
  mocks.list.mockResolvedValue({ agents: [{ name: 'A', category: '' }, { name: 'B', category: '' }] });
  mocks.remove.mockImplementation(async (name: string) => { if (name === 'B') throw new Error('denied'); });
  const { result } = renderHook(() => {
    const manager = useAgentManager();
    const batch = useAgentBatchDelete(manager.filteredGroups, manager.handleBatchDelete);
    return { manager, batch };
  });
  await waitFor(() => expect(result.current.manager.agents).toHaveLength(2));
  act(() => result.current.batch.toggleSelectAll());
  await act(async () => result.current.batch.confirmDelete());
  await act(async () => mocks.confirm.mock.calls[0][0].onOk());
  expect(mocks.remove).toHaveBeenCalledTimes(2);
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(result.current.batch.selectedAgents).toEqual(['B']);
  expect(mocks.warning).toHaveBeenCalledTimes(1);
  expect(mocks.success).not.toHaveBeenCalled();
});
