import axios from 'axios';
import { getRefreshToken, getToken, getUserInfo, removeToken, setRefreshToken, setToken, setUserInfo, synchronizeAuthStorage, type UserInfo } from '../utils/auth';
import { getSessionGeneration, invalidateSession, isCurrentSession, registerSessionReset } from '../utils/authSession';

export interface SessionCredentials extends UserInfo {
  access_token: string;
  refresh_token: string;
  token_type: string;
}
export interface RequestSignal {
  readonly aborted: boolean;
  addEventListener?: AbortSignal['addEventListener'];
  removeEventListener?: AbortSignal['removeEventListener'];
}
export function sessionAbortError(): DOMException {
  return new DOMException('Request no longer belongs to the active session', 'AbortError');
}
export function assertSession(generation: number, signal?: RequestSignal): void {
  if (!isCurrentSession(generation) || signal?.aborted) throw sessionAbortError();
}
export function waitWithSignal<T>(promise: Promise<T>, signal?: RequestSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(sessionAbortError());
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(sessionAbortError()); };
    const cleanup = () => signal.removeEventListener?.('abort', aborted);
    signal.addEventListener?.('abort', aborted, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
export function commitSession(credentials: SessionCredentials): void {
  setToken(credentials.access_token);
  setRefreshToken(credentials.refresh_token);
  setUserInfo({ user_id: credentials.user_id, role: credentials.role });
  invalidateSession();
}
export function clearSession(): void {
  removeToken();
  invalidateSession();
}
let refresh: { generation: number; promise: Promise<string>; controller: AbortController } | undefined;
registerSessionReset(() => { refresh?.controller.abort(); refresh = undefined; });

export async function refreshAccessToken(generation: number, signal?: RequestSignal): Promise<string> {
  assertSession(generation, signal);
  if (!refresh || refresh.generation !== generation) {
    const controller = new AbortController();
    const entry = { generation, controller, promise: Promise.resolve('') };
    // 延后网络调用，确保同步抛错也能在 finally 中释放本次引用。
    entry.promise = Promise.resolve().then(async () => {
      assertSession(generation, controller.signal);
      const refreshToken = getRefreshToken();
      if (!refreshToken) throw new Error('No refresh token is available');
      const response = await waitWithSignal(axios.post<SessionCredentials>('/api/auth/refresh', {
        refresh_token: refreshToken,
      }, { timeout: 15000, signal: controller.signal }), controller.signal);
      assertSession(generation, controller.signal);
      if (!response.data.access_token || !response.data.refresh_token) throw new Error('Invalid refresh response');
      setToken(response.data.access_token);
      setRefreshToken(response.data.refresh_token);
      return response.data.access_token;
    }).catch((error: unknown) => {
      if (isCurrentSession(generation)) clearSession();
      throw error;
    }).finally(() => { if (refresh === entry) refresh = undefined; });
    refresh = entry;
  }
  const token = await waitWithSignal(refresh.promise, signal);
  assertSession(generation, signal);
  return token;
}

// 一个认证边界注册一个 listener；单纯 token 轮换不使编辑草稿失效。
export function subscribeToSessionStorage(): () => void {
  let identity = JSON.stringify(getUserInfo());
  let authenticated = !!getToken();
  const unregisterReset = registerSessionReset(() => {
    // 当前标签页提交身份不会触发 storage 事件，同步刷新长期监听的身份快照。
    identity = JSON.stringify(getUserInfo());
    authenticated = !!getToken();
  });
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && !['auth_token', 'user_info', 'refresh_token'].includes(event.key)) return;
    synchronizeAuthStorage(event);
    const nextIdentity = JSON.stringify(getUserInfo());
    const nextAuthenticated = !!getToken();
    if (nextIdentity !== identity || nextAuthenticated !== authenticated) {
      identity = nextIdentity;
      authenticated = nextAuthenticated;
      invalidateSession();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('storage', onStorage);
    unregisterReset();
  };
}

export function captureSession(): { generation: number; userId: string | null } {
  return { generation: getSessionGeneration(), userId: getUserInfo()?.user_id ?? null };
}
