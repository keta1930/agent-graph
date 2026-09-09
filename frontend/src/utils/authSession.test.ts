import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSessionGeneration,
  invalidateSession,
  isCurrentSession,
  registerSessionReset,
} from './authSession';

const unregister: Array<() => void> = [];

afterEach(() => {
  unregister.splice(0).forEach((remove) => remove());
});

describe('session generation', () => {
  it('invalidates captured generations before notifying subscribers', () => {
    const previous = getSessionGeneration();
    const reset = vi.fn(() => expect(isCurrentSession(previous)).toBe(false));
    unregister.push(registerSessionReset(reset));

    invalidateSession();

    expect(getSessionGeneration()).toBe(previous + 1);
    expect(reset).toHaveBeenCalledOnce();
  });

  it('continues resetting stores when one listener throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reset = vi.fn();
    unregister.push(registerSessionReset(() => { throw new Error('store reset'); }));
    unregister.push(registerSessionReset(reset));

    expect(invalidateSession).not.toThrow();
    expect(reset).toHaveBeenCalledOnce();
  });

  it('stops notifying an unregistered listener', () => {
    const reset = vi.fn();
    registerSessionReset(reset)();
    invalidateSession();
    expect(reset).not.toHaveBeenCalled();
  });
});
