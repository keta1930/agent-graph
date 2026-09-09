import { captureSession } from './authSessionService';
import { isCurrentSession } from '../utils/authSession';

export interface RequestContext {
  generation: number;
  userId: string | null;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

// 每个独立资源各用一个 scope，相同查询共享整个读取与提交过程。
export function createRequestScope() {
  let revision = 0;
  let pending: { key: string; controller: AbortController; promise: Promise<void> } | undefined;
  const invalidate = () => {
    revision += 1;
    pending?.controller.abort();
    pending = undefined;
  };
  const run = (key: string, task: (context: RequestContext) => Promise<void>): Promise<void> => {
    const session = captureSession();
    const requestKey = `${session.generation}:${key}`;
    if (pending?.key === requestKey) return pending.promise;
    invalidate();
    const currentRevision = revision;
    const controller = new AbortController();
    const entry = { key: requestKey, controller, promise: Promise.resolve() };
    const context: RequestContext = {
      ...session,
      signal: controller.signal,
      isCurrent: () => revision === currentRevision && isCurrentSession(session.generation) && !controller.signal.aborted,
    };
    entry.promise = Promise.resolve().then(() => {
      if (context.isCurrent()) return task(context);
    }).finally(() => { if (pending === entry) pending = undefined; });
    pending = entry;
    return entry.promise;
  };
  return { run, invalidate };
}
