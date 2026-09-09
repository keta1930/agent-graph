const TOKEN_KEY = 'auth_token';
const REFRESH_TOKEN_KEY = 'refresh_token';
const USER_INFO_KEY = 'user_info';

export interface UserInfo {
  user_id: string;
  role: 'super_admin' | 'admin' | 'user' | 'normal';
}

const AUTH_KEYS = [TOKEN_KEY, REFRESH_TOKEN_KEY, USER_INFO_KEY] as const;
type AuthKey = typeof AUTH_KEYS[number];
type CredentialSnapshot = Record<AuthKey, string | null>;
const memory = new Map<AuthKey, string | null>();
const persisted = new Map<AuthKey, string | null>();
const failedWrites = new Set<AuthKey>();

function readStorageSnapshot(): CredentialSnapshot | undefined {
  try {
    return {
      [TOKEN_KEY]: localStorage.getItem(TOKEN_KEY),
      [REFRESH_TOKEN_KEY]: localStorage.getItem(REFRESH_TOKEN_KEY),
      [USER_INFO_KEY]: localStorage.getItem(USER_INFO_KEY),
    };
  } catch { return undefined; }
}
function remember(snapshot: CredentialSnapshot): void {
  for (const key of AUTH_KEYS) {
    memory.set(key, snapshot[key]);
    persisted.set(key, snapshot[key]);
  }
}
function captureBeforeWrite(): void {
  if (failedWrites.size) return;
  const snapshot = readStorageSnapshot();
  if (snapshot) remember(snapshot);
}
function read(key: AuthKey): string | null {
  // 部分字段写入失败时，整组凭据取当前标签页快照，避免新旧身份混用。
  if (failedWrites.size) return memory.get(key) ?? null;
  try {
    const value = localStorage.getItem(key);
    memory.set(key, value);
    persisted.set(key, value);
    return value;
  } catch { return memory.get(key) ?? null; }
}
function write(key: AuthKey, value: string): void {
  captureBeforeWrite();
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
    persisted.set(key, value);
    failedWrites.delete(key);
  } catch { failedWrites.add(key); }
}

export function synchronizeAuthStorage(event: StorageEvent): void {
  if (event.key !== null && !AUTH_KEYS.some(key => key === event.key)) return;
  try { if (event.storageArea && event.storageArea !== localStorage) return; } catch { return; }
  const snapshot = readStorageSnapshot();
  if (!snapshot) return;
  // 旧事件可能在本地失败写入后才到达，只有实际外部变更才能接管内存身份。
  if (failedWrites.size && AUTH_KEYS.every(key => snapshot[key] === persisted.get(key))) return;
  failedWrites.clear();
  remember(snapshot);
}
export const setToken = (token: string): void => write(TOKEN_KEY, token);
export const getToken = (): string | null => read(TOKEN_KEY);
export const setRefreshToken = (token: string): void => write(REFRESH_TOKEN_KEY, token);
export const getRefreshToken = (): string | null => read(REFRESH_TOKEN_KEY);
export const removeToken = (): void => {
  captureBeforeWrite();
  for (const key of AUTH_KEYS) {
    memory.set(key, null);
    try {
      localStorage.removeItem(key);
      persisted.set(key, null);
      failedWrites.delete(key);
    } catch { failedWrites.add(key); }
  }
};
export const isAuthenticated = (): boolean => !!getToken();
export function getUserInfo(): UserInfo | null {
  try {
    const value: unknown = JSON.parse(read(USER_INFO_KEY) ?? 'null');
    if (!value || typeof value !== 'object' || !('user_id' in value) || !('role' in value)) return null;
    if (typeof value.user_id !== 'string') return null;
    const role = value.role;
    if (role !== 'admin' && role !== 'super_admin' && role !== 'user' && role !== 'normal') return null;
    return { user_id: value.user_id, role };
  } catch { return null; }
}
export const setUserInfo = (userInfo: UserInfo): void => write(USER_INFO_KEY, JSON.stringify(userInfo));
export const isAdmin = (): boolean => {
  const role = getUserInfo()?.role;
  return role === 'admin' || role === 'super_admin';
};
