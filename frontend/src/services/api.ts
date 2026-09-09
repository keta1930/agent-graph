import axios, { type InternalAxiosRequestConfig } from 'axios';
import { getToken } from '../utils/auth';
import { getSessionGeneration, isCurrentSession } from '../utils/authSession';
import { assertSession, clearSession, refreshAccessToken, sessionAbortError } from './authSessionService';

interface SessionRequest extends InternalAxiosRequestConfig {
  sessionGeneration?: number;
  authRetried?: boolean;
}
const api = axios.create({ baseURL: '/api', timeout: 30000, headers: { 'Content-Type': 'application/json' } });
const isAuthEndpoint = (url = '') => /(?:^|\/)auth\/(?:login|register|refresh|logout)(?:[/?]|$)/.test(url);
const isPublicRequest = (config: SessionRequest) => isAuthEndpoint(config.url) || (config.method === 'get' && /^\/?share\//.test(config.url ?? ''));

api.interceptors.request.use((config: SessionRequest) => {
  config.sessionGeneration ??= getSessionGeneration();
  assertSession(config.sessionGeneration, config.signal);
  const token = getToken();
  if (!isAuthEndpoint(config.url)) {
    if (token) config.headers.set('Authorization', `Bearer ${token}`);
    else config.headers.delete('Authorization');
  }
  return config;
});
api.interceptors.response.use(response => {
  const config: SessionRequest = response.config;
  assertSession(config.sessionGeneration ?? getSessionGeneration(), config.signal);
  return response;
}, async (error: unknown) => {
  if (!axios.isAxiosError(error) || !error.config) throw error;
  const config: SessionRequest = error.config;
  const generation = config.sessionGeneration ?? getSessionGeneration();
  assertSession(generation, config.signal);
  if (error.response?.status !== 401 || isPublicRequest(config)) throw error;
  if (config.authRetried) {
    if (isCurrentSession(generation)) clearSession();
    throw error;
  }
  config.authRetried = true;
  // 其他请求已完成正常轮换时，直接用最新凭据做本次唯一重放。
  const token = getToken();
  if (!token || config.headers.get('Authorization') === `Bearer ${token}`) {
    await refreshAccessToken(generation, config.signal);
  }
  if (!isCurrentSession(generation)) throw sessionAbortError();
  assertSession(generation, config.signal);
  return api(config);
});
export default api;
