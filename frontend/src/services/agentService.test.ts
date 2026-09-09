import { expect, it, vi, expectTypeOf } from 'vitest';
import api from './api';
import { getAgent, listAgents, listAgentsInCategory, deleteAgent, type AgentListResponse, type AgentDetailResponse } from './agentService';
it('returns typed list data without changing the pagination contract', async () => {
  const data: AgentListResponse = { agents: [], total_count: 150 };
  vi.spyOn(api, 'get').mockResolvedValue({ data });
  expectTypeOf<typeof listAgents>().returns.toEqualTypeOf<Promise<AgentListResponse>>();
  expectTypeOf<typeof getAgent>().returns.toEqualTypeOf<Promise<AgentDetailResponse>>();
  expect(await listAgents('category', 20, 10)).toBe(data);
});
it('encodes agent names and categories with reserved characters', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({ data: {} });
  const remove = vi.spyOn(api, 'delete').mockResolvedValue({ data: {} });
  await getAgent('你好 #?%'); await listAgentsInCategory('a & b'); await deleteAgent('a#b');
  expect(get.mock.calls[0][0]).toBe('/agent/%E4%BD%A0%E5%A5%BD%20%23%3F%25');
  expect(get.mock.calls[1][0]).toBe('/agent/category/a%20%26%20b');
  expect(remove.mock.calls[0][0]).toBe('/agent/a%23b');
});
