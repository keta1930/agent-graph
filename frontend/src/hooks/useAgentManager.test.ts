import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useAgentManager } from './useAgentManager';
import { useAgentBatchDelete } from './useAgentBatchDelete';
import api from '../services/api';

const messages = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('../i18n/hooks', () => { const t = (key: string) => key; return { useT: () => t }; });
vi.mock('antd', () => ({ App: { useApp: () => ({ message: messages, modal: { confirm: vi.fn() } }) } }));
vi.mock('../services/modelService', () => ({ getModels: async () => [] }));
vi.mock('../services/systemToolsService', () => ({ listSystemTools: async () => ({ categories: [] }) }));
vi.mock('../services/mcpService', () => ({ getMCPConfig: async () => ({ mcpServers: {} }) }));

it('searches and selects agents on the last page and preserves the complete list on refresh failure', async () => {
  const agents = Array.from({ length: 101 }, (_, index) => ({ name: index === 100 ? 'last-only-keyword' : `Agent ${index}`, category: 'coding', tags: [], model: '', created_at: '', updated_at: '' }));
  let fail = false;
  vi.spyOn(api, 'get').mockImplementation(async (url, config) => {
    if (url === '/agent/categories') return { data: { categories: [] } };
    const skip = config?.params.skip as number;
    if (skip === 100 && fail) throw new Error('page failed');
    return { data: { agents: agents.slice(skip, skip + 100), total_count: 101 } };
  });
  const { result } = renderHook(() => {
    const manager = useAgentManager();
    const batch = useAgentBatchDelete(manager.filteredGroups, manager.handleBatchDelete);
    return { manager, batch };
  });
  await waitFor(() => expect(result.current.manager.agents).toHaveLength(101));
  act(() => result.current.batch.toggleSelectAll());
  expect(result.current.batch.selectedAgents).toHaveLength(101);
  act(() => result.current.manager.setSearchText('last-only-keyword'));
  expect(result.current.manager.filteredGroups[0].agents.map(agent => agent.name)).toEqual(['last-only-keyword']);
  fail = true;
  await act(async () => result.current.manager.loadAgents());
  expect(result.current.manager.agents).toHaveLength(101);
  expect(result.current.manager.searchText).toBe('last-only-keyword');
  expect(messages.error).toHaveBeenCalledTimes(1);
});
