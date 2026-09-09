let generation = 0;
const resetListeners = new Set<() => void>();

export function getSessionGeneration(): number {
  return generation;
}

export function isCurrentSession(capturedGeneration: number): boolean {
  return capturedGeneration === generation;
}

export function registerSessionReset(reset: () => void): () => void {
  resetListeners.add(reset);
  return () => { resetListeners.delete(reset); };
}

export function invalidateSession(): void {
  generation += 1;
  // 一个 store 清理失败不能让其他用户数据留在内存中。
  for (const reset of [...resetListeners]) {
    try {
      reset();
    } catch {
      console.error('A session reset listener failed.');
    }
  }
}
