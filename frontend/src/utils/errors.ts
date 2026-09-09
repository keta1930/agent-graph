function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (isRecord(value) && typeof value.message === 'string' && value.message.trim()) {
    return value.message;
  }
  return undefined;
}

/** 从已知错误字段获取消息，避免把整个响应或凭据序列化到界面。 */
export function getErrorMessage(error: unknown, fallback = 'An unexpected error occurred'): string {
  if (!isRecord(error)) return fallback;
  const response = error.response;
  if (isRecord(response) && isRecord(response.data)) {
    const message = readMessage(response.data.detail) ?? readMessage(response.data.message);
    if (message) return message;
  }
  return readMessage(error.detail) ?? readMessage(error.message) ?? fallback;
}
