import { beforeEach, expect, it, vi } from 'vitest';
import { useConversationStore as store } from './conversationStore';
import { ConversationService, ConversationStorage } from '../services/conversationService';
import { commitSession, clearSession } from '../services/authSessionService';
import api from '../services/api';
import type { ConversationDetail, ConversationSummary } from '../types/conversation';
vi.mock('antd', () => ({ message: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const detail = (id: string): ConversationDetail => ({ conversation_id: id, title: id, type: 'agent', rounds: [] });
const summary = (id: string): ConversationSummary => ({ conversation_id: id, title: id, user_id: 'alice', type: 'agent', status: 'active', tags: [], created_at: '', updated_at: '', round_count: 0, total_token_usage: { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 } });
beforeEach(() => {
  localStorage.clear();
  commitSession({ user_id: 'alice', role: 'user', access_token: 'a', refresh_token: 'r', token_type: 'bearer' });
});
it('ignores detail A resolving after B, including its finally', async () => {
  const a = deferred<ConversationDetail>(), b = deferred<ConversationDetail>();
  vi.spyOn(ConversationService, 'getConversationDetail').mockImplementation(id => id === 'a' ? a.promise : b.promise);
  const first = store.getState().loadConversationDetail('a'); await Promise.resolve();
  const second = store.getState().loadConversationDetail('b'); await Promise.resolve();
  a.resolve(detail('a')); await first;
  expect(store.getState().currentConversationLoading).toBe(true);
  b.resolve(detail('b')); await second;
  expect(store.getState().currentConversation?.conversation_id).toBe('b');
});
it.each(['clear', 'temporary', 'logout'])('invalidates a pending detail on %s', async action => {
  const pending = deferred<ConversationDetail>();
  vi.spyOn(ConversationService, 'getConversationDetail').mockReturnValue(pending.promise);
  const loading = store.getState().loadConversationDetail('a'); await Promise.resolve();
  if (action === 'clear') store.getState().clearCurrentConversation();
  if (action === 'temporary') store.getState().updateCurrentConversationTemporarily(detail('b'));
  if (action === 'logout') clearSession();
  pending.resolve(detail('a')); await loading;
  expect(store.getState().currentConversation?.conversation_id ?? null).toBe(action === 'temporary' ? 'b' : null);
  expect(store.getState().currentConversationLoading).toBe(false);
});
it('deduplicates simultaneous list loads and tolerates cache write failure', async () => {
  const pending = deferred<{ conversations: ConversationSummary[]; total_count: number }>();
  const network = vi.spyOn(ConversationService, 'getConversations').mockReturnValue(pending.promise);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  const first = store.getState().loadConversations(true), second = store.getState().loadConversations(true);
  await Promise.resolve(); pending.resolve({ conversations: [summary('a')], total_count: 7 });
  await Promise.all([first, second]);
  expect(network).toHaveBeenCalledTimes(1);
  expect(store.getState().totalCount).toBe(7);
  expect(store.getState().conversations).toHaveLength(1);
});

it('commits and caches only complete paginated lists and preserves them after a failed middle page', async () => {
  const conversations = Array.from({ length: 201 }, (_, index) => summary(`${index}`));
  let fail = false;
  const get = vi.spyOn(api, 'get').mockImplementation(async (_url, config) => {
    const skip = config?.params.skip as number;
    if (skip === 200 && fail) throw new Error('middle page failed');
    return { data: { conversations: conversations.slice(skip, skip + 200), total_count: 201 } };
  });
  await store.getState().loadConversations(true);
  expect(store.getState().conversations).toHaveLength(201);
  expect(ConversationStorage.getCachedConversationList('alice')?.conversations).toHaveLength(201);
  store.getState().setSearchQuery('200');
  fail = true;
  await store.getState().silentUpdateConversations();
  expect(get).toHaveBeenCalledTimes(4);
  expect(store.getState()).toMatchObject({ conversations, totalCount: 201, searchQuery: '200', error: 'middle page failed' });
  expect(ConversationStorage.getCachedConversationList('alice')?.conversations).toHaveLength(201);
});

it('does not cache a late page after logout', async () => {
  const page = deferred<{ data: { conversations: ConversationSummary[]; total_count: number } }>();
  const conversations = Array.from({ length: 200 }, (_, index) => summary(`${index}`));
  vi.spyOn(api, 'get').mockResolvedValueOnce({ data: { conversations, total_count: 201 } }).mockReturnValueOnce(page.promise);
  const loading = store.getState().loadConversations(true);
  await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  clearSession();
  page.resolve({ data: { conversations: [summary('200')], total_count: 201 } });
  await loading;
  expect(store.getState()).toMatchObject({ conversations: [], totalCount: 0, loading: false, error: null });
  expect(ConversationStorage.getCachedConversationList('alice')).toBeNull();
});
it('removes missing IDs during silent refresh while preserving retained order', async () => {
  store.setState({ conversations: [summary('b'), summary('gone'), summary('a')] });
  vi.spyOn(ConversationService, 'getConversations').mockResolvedValue({ conversations: [summary('new'), summary('a'), summary('b')], total_count: 3 });
  await store.getState().silentUpdateConversations();
  expect(store.getState().conversations.map(item => item.conversation_id)).toEqual(['new', 'b', 'a']);
});
it('updates only successful batch IDs and reports individual failures', async () => {
  store.setState({ conversations: [summary('a'), summary('b')], totalCount: 2 });
  vi.spyOn(ConversationService, 'deleteConversationPermanent').mockImplementation(id => id === 'a' ? Promise.resolve() : Promise.reject(new Error('denied')));
  vi.spyOn(ConversationService, 'getConversations').mockRejectedValue(new Error('refresh offline'));
  const result = await store.getState().batchDeleteConversations(['a', 'b'], true);
  expect(result).toEqual({ succeededIds: ['a'], failed: [{ id: 'b', message: 'denied' }] });
  expect(store.getState().conversations.map(item => item.conversation_id)).toEqual(['b']);
  expect(store.getState().error).toBe('refresh offline');
});
it('rejects failed mutations and leaves data intact', async () => {
  store.setState({ conversations: [summary('a')] });
  vi.spyOn(ConversationService, 'updateConversationTitle').mockRejectedValue(new Error('denied'));
  await expect(store.getState().updateConversationTitle('a', 'new')).rejects.toThrow('denied');
  expect(store.getState().conversations[0].title).toBe('a');
});
it('isolates cached lists by user and removes legacy entries', () => {
  localStorage.setItem('conversations_cache', '{}');
  ConversationStorage.cacheConversationList({ conversations: [summary('a')], total_count: 1 }, 'alice');
  expect(ConversationStorage.getCachedConversationList('bob')).toBeNull();
  expect(ConversationStorage.getCachedConversationList('alice')?.total_count).toBe(1);
  expect(localStorage.getItem('conversations_cache')).toBeNull();
});
it('keeps the current conversation and skips refresh when the whole batch fails', async () => {
  store.setState({ currentConversation: detail('a'), conversations: [summary('a')], totalCount: 1 });
  vi.spyOn(ConversationService, 'deleteConversationPermanent').mockRejectedValue(new Error('denied'));
  const list = vi.spyOn(ConversationService, 'getConversations');
  const result = await store.getState().batchDeleteConversations(['a'], true);
  expect(result.succeededIds).toEqual([]);
  expect(store.getState().currentConversation?.conversation_id).toBe('a');
  expect(list).not.toHaveBeenCalled();
});
it('clears a successfully deleted current conversation and refreshes once', async () => {
  store.setState({ currentConversation: detail('a'), conversations: [summary('a'), summary('b')], totalCount: 2 });
  vi.spyOn(ConversationService, 'deleteConversationPermanent').mockResolvedValue();
  const list = vi.spyOn(ConversationService, 'getConversations').mockResolvedValue({ conversations: [], total_count: 0 });
  await store.getState().batchDeleteConversations(['a', 'b'], true);
  expect(store.getState().currentConversation).toBeNull();
  expect(list).toHaveBeenCalledOnce();
});

it('applies deferred soft/permanent batch results before one explicit authoritative refresh', async () => {
  store.setState({ conversations: [summary('soft'), { ...summary('permanent'), status: 'deleted' }, summary('failed')], totalCount: 3 });
  vi.spyOn(ConversationService, 'updateConversationStatus').mockImplementation(id => id === 'failed' ? Promise.reject(new Error('denied')) : Promise.resolve());
  vi.spyOn(ConversationService, 'deleteConversationPermanent').mockResolvedValue();
  const list = vi.spyOn(ConversationService, 'getConversations').mockResolvedValue({ conversations: [{ ...summary('soft'), status: 'deleted' }, summary('failed')], total_count: 2 });
  const soft = await store.getState().batchDeleteConversations(['soft', 'failed'], false, { refresh: false });
  const permanent = await store.getState().batchDeleteConversations(['permanent'], true, { refresh: false });
  expect(soft).toEqual({ succeededIds: ['soft'], failed: [{ id: 'failed', message: 'denied' }] });
  expect(permanent.succeededIds).toEqual(['permanent']);
  expect(list).not.toHaveBeenCalled();
  expect(store.getState().conversations.map(item => [item.conversation_id, item.status])).toEqual([['soft', 'deleted'], ['failed', 'active']]);
  await store.getState().silentUpdateConversations();
  expect(list).toHaveBeenCalledOnce();
});
