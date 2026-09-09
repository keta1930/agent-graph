import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitSession, clearSession, refreshAccessToken } from './authSessionService';
import { getToken } from '../utils/auth';
import { getSessionGeneration } from '../utils/authSession';
vi.mock('axios', () => ({ default: { post: vi.fn() } }));
const credentials = { user_id: 'alice', role: 'user' as const, access_token: 'old', refresh_token: 'refresh', token_type: 'bearer' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => { clearSession(); vi.mocked(axios.post).mockReset(); commitSession(credentials); });
describe('authentication refresh lifecycle', () => {
  it('shares refresh and keeps the same session generation', async () => {
    const pending = deferred<{ data: typeof credentials }>();
    vi.mocked(axios.post).mockReturnValue(pending.promise);
    const generation = getSessionGeneration();
    const first = refreshAccessToken(generation);
    const second = refreshAccessToken(generation);
    pending.resolve({ data: { ...credentials, access_token: 'new' } });
    await expect(Promise.all([first, second])).resolves.toEqual(['new', 'new']);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(getSessionGeneration()).toBe(generation);
  });
  it('does not resurrect a logged out session from a late refresh', async () => {
    const pending = deferred<{ data: typeof credentials }>();
    vi.mocked(axios.post).mockReturnValue(pending.promise);
    const refreshing = refreshAccessToken(getSessionGeneration());
    const rejection = expect(refreshing).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(axios.post).toHaveBeenCalledOnce());
    clearSession();
    pending.resolve({ data: { ...credentials, access_token: 'late' } });
    await rejection;
    expect(getToken()).toBeNull();
  });
  it('releases a missing-token refresh so a new login can refresh', async () => {
    localStorage.removeItem('refresh_token');
    await expect(refreshAccessToken(getSessionGeneration())).rejects.toThrow();
    commitSession(credentials);
    vi.mocked(axios.post).mockResolvedValue({ data: { ...credentials, access_token: 'new' } });
    await expect(refreshAccessToken(getSessionGeneration())).resolves.toBe('new');
  });
  it('caller cancellation does not cancel the shared refresh', async () => {
    const pending = deferred<{ data: typeof credentials }>();
    vi.mocked(axios.post).mockReturnValue(pending.promise);
    const controller = new AbortController();
    const first = refreshAccessToken(getSessionGeneration(), controller.signal);
    const second = refreshAccessToken(getSessionGeneration());
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve({ data: { ...credentials, access_token: 'new' } });
    await expect(second).resolves.toBe('new');
  });
});
it('clears refresh failure and applies a bounded timeout to the independent request', async () => {
  vi.mocked(axios.post).mockRejectedValueOnce(new Error('timeout'));
  await expect(refreshAccessToken(getSessionGeneration())).rejects.toThrow('timeout');
  expect(axios.post).toHaveBeenCalledWith('/api/auth/refresh', expect.any(Object), expect.objectContaining({ timeout: 15000, signal: expect.any(AbortSignal) }));
  expect(getToken()).toBeNull();
  commitSession(credentials);
  vi.mocked(axios.post).mockResolvedValue({ data: { ...credentials, access_token: 'after' } });
  await expect(refreshAccessToken(getSessionGeneration())).resolves.toBe('after');
});
