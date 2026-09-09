import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import AgentSelector from './AgentSelector';
import AgentPicker from './AgentPicker';
import api from '../../../services/api';
import type { AgentListItem } from '../../../services/agentService';

vi.mock('../../../i18n/hooks', () => { const t = (key: string) => key; return { useT: () => t }; });
vi.mock('./AgentList', () => ({ default: ({ agents, onSelect }: { agents: AgentListItem[]; onSelect: (name: string) => void }) => <div>{agents.map(agent => <button key={agent.name} onClick={() => onSelect(agent.name)}>{agent.name}</button>)}</div> }));
const agents = Array.from({ length: 101 }, (_, index) => ({ name: index === 100 ? 'last-only-keyword' : `Agent ${index}`, category: 'coding', tags: [], model: '', created_at: '', updated_at: '' }));

it.each(['selector', 'picker'])('%s can select the agent on the second page', async kind => {
  const get = vi.spyOn(api, 'get').mockImplementation(async (url, config) => {
    if (url === '/agent/categories') return { data: { categories: [] } };
    const skip = config?.params.skip as number;
    return { data: { agents: agents.slice(skip, skip + 100), total_count: 101 } };
  });
  const selected = vi.fn();
  if (kind === 'selector') render(<AgentSelector onAgentSelect={selected} />);
  else { render(<AgentPicker selectedAgent={null} onAgentChange={selected} />); fireEvent.click(screen.getByRole('button')); }
  fireEvent.click(await screen.findByText('last-only-keyword'));
  expect(selected).toHaveBeenCalledWith('last-only-keyword');
  expect(get.mock.calls.filter(call => call[0] === '/agent/list').map(call => call[1]?.params.skip)).toEqual([0, 100]);
});

it.each(['selector', 'picker'])('%s aborts a late page on unmount without fetching another page', async kind => {
  let release!: (value: { data: { agents: AgentListItem[]; total_count: number } }) => void;
  const pending = new Promise<{ data: { agents: AgentListItem[]; total_count: number } }>(resolve => { release = resolve; });
  const get = vi.spyOn(api, 'get').mockImplementation(async url => url === '/agent/categories' ? { data: { categories: [] } } : pending);
  const view = render(kind === 'selector' ? <AgentSelector onAgentSelect={vi.fn()} /> : <AgentPicker selectedAgent={null} onAgentChange={vi.fn()} />);
  if (kind === 'picker') fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(get.mock.calls.some(call => call[0] === '/agent/list')).toBe(true));
  const request = get.mock.calls.find(call => call[0] === '/agent/list');
  view.unmount();
  expect(request?.[1]?.signal?.aborted).toBe(true);
  await act(async () => release({ data: { agents: agents.slice(0, 100), total_count: 101 } }));
  expect(get.mock.calls.filter(call => call[0] === '/agent/list')).toHaveLength(1);
});
