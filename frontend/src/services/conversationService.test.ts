import { beforeEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import api from './api';
import { ConversationService } from './conversationService';
import { commitSession, clearSession } from './authSessionService';
const credentials = { user_id: 'alice', role: 'user' as const, access_token: 'old', refresh_token: 'r', token_type: 'bearer' };
beforeEach(() => { commitSession(credentials); });
it('replays the same uploaded FormData once after refresh', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(axios, 'post').mockResolvedValue({ data: { ...credentials, access_token: 'new' } });
  const file = new File(['hello'], 'file.txt');
  const reader = await ConversationService.createAgentRunSSE({ user_prompt: 'hello', files: [file] });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
  expect(fetcher.mock.calls[1][1].body.get('files')).toBe(file);
  expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer new');
  await reader.cancel();
});
it('does not replay an aborted stream waiting for shared refresh', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise(value => { resolve = value; });
  vi.spyOn(axios, 'post').mockReturnValue(pending);
  const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  const request = ConversationService.createAgentRunSSE({ user_prompt: 'hello' }, { signal: controller.signal });
  await vi.waitFor(() => expect(axios.post).toHaveBeenCalled());
  controller.abort();
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  resolve({ data: { ...credentials, access_token: 'new' } });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('cancels a handshake response arriving after logout', async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>(yes => { resolve = yes; })));
  const request = ConversationService.createAgentRunSSE({ user_prompt: 'hello' });
  clearSession();
  const response = new Response('late');
  const cancel = vi.spyOn(response.body!, 'cancel');
  resolve(response);
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancel).toHaveBeenCalledOnce();
});
it('encodes reserved characters in shared file and share ID segments', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({ data: new Blob() });
  await ConversationService.downloadSharedFile('a/#', '目录/a #?%.txt');
  expect(get.mock.calls[0][0]).toBe('/share/a%2F%23/file/%E7%9B%AE%E5%BD%95%2Fa%20%23%3F%25.txt');
});
it('replays Graph JSON unchanged after a single refresh', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(new Response('done'));
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(axios, 'post').mockResolvedValue({ data: { ...credentials, access_token: 'new' } });
  const payload = { graph_name: 'graph', input_text: 'https://a.test/#? 中文', conversation_id: 'id' };
  const reader = await ConversationService.createGraphSSE(payload);
  expect(fetcher.mock.calls.map(call => call[1].body)).toEqual([JSON.stringify(payload), JSON.stringify(payload)]);
  await reader.cancel();
});
it.each([403, 422])('does not refresh or replay a stream HTTP %s failure', async status => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'denied' }), { status }));
  vi.stubGlobal('fetch', fetcher);
  const refresh = vi.spyOn(axios, 'post');
  await expect(ConversationService.createAgentRunSSE({ user_prompt: 'hello' })).rejects.toThrow('denied');
  expect(fetcher).toHaveBeenCalledOnce(); expect(refresh).not.toHaveBeenCalled();
});
