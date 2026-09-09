import axios, { AxiosError, AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { beforeEach, expect, it, vi } from 'vitest';
import api from './api';
import { ConversationService } from './conversationService';
import { commitSession, clearSession } from './authSessionService';
import { getToken } from '../utils/auth';
const credentials = { user_id: 'alice', role: 'user' as const, access_token: 'old', refresh_token: 'r', token_type: 'bearer' };
const response = (config: InternalAxiosRequestConfig, status = 200): AxiosResponse => ({ config, status, statusText: '', data: {}, headers: new AxiosHeaders() });
const unauthorized = (config: InternalAxiosRequestConfig) => new AxiosError('Unauthorized', undefined, config, undefined, response(config, 401));
beforeEach(() => { commitSession(credentials); });
it('shares one refresh between concurrent REST and SSE requests', async () => {
  let resolve!: (value: { data: typeof credentials }) => void;
  const refresh = vi.spyOn(axios, 'post').mockReturnValue(new Promise(yes => { resolve = yes; }));
  const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
    if (config.headers.get('Authorization') === 'Bearer old') throw unauthorized(config);
    return response(config);
  });
  const rest = api.get('/models', { adapter });
  const fetcher = vi.fn().mockImplementation(async (_url, init: RequestInit) => new Response('', { status: (init.headers as Record<string, string>).Authorization === 'Bearer old' ? 401 : 200 }));
  vi.stubGlobal('fetch', fetcher);
  const stream = ConversationService.createAgentRunSSE({ user_prompt: 'test' });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  resolve({ data: { ...credentials, access_token: 'new' } });
  const [, reader] = await Promise.all([rest, stream]);
  expect(refresh).toHaveBeenCalledOnce();
  expect(adapter).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await reader.cancel();
});
it.each(['/auth/login', '/auth/register', '/auth/refresh'])('does not refresh a public authentication failure at %s', async url => {
  const refresh = vi.spyOn(axios, 'post');
  await expect(api.post(url, {}, { adapter: config => Promise.reject(unauthorized(config)) })).rejects.toThrow('Unauthorized');
  expect(refresh).not.toHaveBeenCalled();
  expect(getToken()).toBe('old');
});
it('replays each protected request at most once and clears terminal failure', async () => {
  vi.spyOn(axios, 'post').mockResolvedValue({ data: { ...credentials, access_token: 'new' } });
  const adapter = vi.fn((config: InternalAxiosRequestConfig) => Promise.reject(unauthorized(config)));
  await expect(api.get('/models', { adapter })).rejects.toThrow('Unauthorized');
  expect(adapter).toHaveBeenCalledTimes(2);
  expect(getToken()).toBeNull();
});
it('rejects successful responses from an old session', async () => {
  let resolve!: (value: AxiosResponse) => void;
  let config!: InternalAxiosRequestConfig;
  const request = api.get('/models', { adapter: value => { config = value; return new Promise(yes => { resolve = yes; }); } });
  await vi.waitFor(() => expect(config).toBeDefined());
  clearSession(); resolve(response(config));
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
});
it('does not attach an old authorization default after logout', async () => {
  clearSession();
  const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => response(config));
  await api.get('/public', { adapter });
  expect(adapter.mock.calls[0][0].headers.has('Authorization')).toBe(false);
});
it('settles repeated failed logins without any stored refresh token', async () => {
  clearSession();
  const refresh = vi.spyOn(axios, 'post');
  const adapter = (config: InternalAxiosRequestConfig) => Promise.reject(unauthorized(config));
  await expect(api.post('/auth/login', {}, { adapter })).rejects.toThrow('Unauthorized');
  await expect(api.post('/auth/login', {}, { adapter })).rejects.toThrow('Unauthorized');
  expect(refresh).not.toHaveBeenCalled();
});
