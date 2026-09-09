import { describe, expect, it, vi } from 'vitest';
import { collectPages } from '../utils/pagination';
import { invalidateSession } from '../utils/authSession';
import api from './api';
import { listAllAgents } from './agentService';
import { ConversationService } from './conversationService';
import type { ConversationSummary } from '../types/conversation';

describe('complete list pagination', () => {
  it.each([0, 100, 101, 200, 201, 400])('collects all %i items with bounded pages', async total => {
    const items = Array.from({ length: total }, (_, id) => ({ id }));
    const fetchPage = vi.fn(async (limit: number, skip: number) => ({ items: items.slice(skip, skip + limit), total_count: total }));
    expect(await collectPages(fetchPage, { pageSize: 100, keyOf: item => item.id })).toEqual({ items, total_count: total });
    expect(fetchPage.mock.calls.map(call => call[1])).toEqual(Array.from({ length: Math.max(1, Math.ceil(total / 100)) }, (_, page) => page * 100));
  });

  it('advances by raw page length while removing duplicates', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ items: ['a', 'b'], total_count: 5 })
      .mockResolvedValueOnce({ items: ['b', 'c'], total_count: 5 })
      .mockResolvedValueOnce({ items: ['d'], total_count: 5 });
    expect(await collectPages<string>(fetchPage, { pageSize: 2, keyOf: item => item })).toEqual({ items: ['a', 'b', 'c', 'd'], total_count: 5 });
    expect(fetchPage.mock.calls.map(call => call[1])).toEqual([0, 2, 4]);
  });

  it('rejects a repeated page instead of looping or returning a partial list', async () => {
    const fetchPage = vi.fn(async () => ({ items: ['a', 'b'], total_count: 400 }));
    await expect(collectPages(fetchPage, { pageSize: 2, keyOf: item => item })).rejects.toThrow('progress');
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('rejects the whole list when a middle page fails', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({ items: ['a'], total_count: 3 }).mockRejectedValueOnce(new Error('page failed'));
    await expect(collectPages<string>(fetchPage, { pageSize: 1, keyOf: item => item })).rejects.toThrow('page failed');
  });

  it.each(['abort', 'session'])('stops after a late page following %s invalidation', async invalidation => {
    const controller = new AbortController();
    const fetchPage = vi.fn(async () => {
      if (invalidation === 'abort') controller.abort(); else invalidateSession();
      return { items: ['a'], total_count: 3 };
    });
    await expect(collectPages(fetchPage, { pageSize: 1, keyOf: item => item, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('does not request the first page when already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    const fetchPage = vi.fn();
    await expect(collectPages<string>(fetchPage, { pageSize: 100, keyOf: item => item, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('uses actual agent page calls and retains category, signal and authoritative count', async () => {
    const agents = Array.from({ length: 101 }, (_, index) => ({ name: `agent-${index}`, category: 'coding', tags: [], model: 'model', created_at: '', updated_at: '' }));
    const get = vi.spyOn(api, 'get').mockResolvedValueOnce({ data: { agents: agents.slice(0, 100), total_count: 101 } }).mockResolvedValueOnce({ data: { agents: agents.slice(100), total_count: 101 } });
    const controller = new AbortController();
    expect(await listAllAgents('coding', { signal: controller.signal })).toEqual({ agents, total_count: 101 });
    expect(get).toHaveBeenLastCalledWith('/agent/list', { params: { category: 'coding', limit: 100, skip: 100 }, signal: controller.signal });
  });

  it.each([0, 200, 201, 400])('collects %i conversations through actual page requests', async total => {
    const conversations: ConversationSummary[] = Array.from({ length: total }, (_, index) => ({ conversation_id: `${index}`, user_id: 'user', type: 'agent', title: `${index}`, status: 'active', tags: [], created_at: '', updated_at: '', round_count: 0, total_token_usage: { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 } }));
    const get = vi.spyOn(api, 'get').mockImplementation(async (_url, config) => {
      const { skip, limit } = config?.params as { skip: number; limit: number };
      return { data: { conversations: conversations.slice(skip, skip + limit), total_count: total } };
    });
    expect(await ConversationService.getConversations()).toEqual({ conversations, total_count: total });
    expect(get.mock.calls.map(call => call[1]?.params.skip)).toEqual(total > 200 ? [0, 200] : [0]);
  });
});
