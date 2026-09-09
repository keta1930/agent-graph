import api from './api'
import { assertSession, clearSession, commitSession, type SessionCredentials } from './authSessionService'
import { getSessionGeneration } from '../utils/authSession'
import { getToken } from '../utils/auth'

export interface LoginRequest {
  user_id: string
  password: string
}

export type LoginResponse = SessionCredentials

export interface RegisterRequest {
  invite_code: string
  user_id: string
  password: string
  language?: string  // 语言偏好: 'en' 或 'zh'
}

export const login = async (userId: string, password: string): Promise<LoginResponse> => {
  const generation = getSessionGeneration()
  const response = await api.post<LoginResponse>('/auth/login', {
    user_id: userId,
    password: password
  })
  assertSession(generation)
  commitSession(response.data)
  return response.data
}

export const register = async (
  inviteCode: string,
  userId: string,
  password: string,
  language: string = 'en'  // 默认为英语
): Promise<void> => {
  await api.post('/auth/register', {
    invite_code: inviteCode,
    user_id: userId,
    password: password,
    language: language
  })
}

export const logout = async (): Promise<void> => {
  const token = getToken()
  clearSession()
  try {
    await api.post('/auth/logout', undefined, { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
  } catch {
    console.warn('Logout API call failed; local credentials have been cleared.')
  }
}

export const getCurrentUser = async () => {
  const response = await api.get('/auth/me')
  return response.data
}
