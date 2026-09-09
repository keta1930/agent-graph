import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useTour, type TourStep } from './useTour';

const mock = vi.hoisted(() => ({ config: {} as Record<string, () => void>, index: 0, create: vi.fn(), destroy: vi.fn(), drive: vi.fn(), next: vi.fn() }));
vi.mock('../../i18n/hooks', () => { const t = (key: string) => key; return { useT: () => t }; });
vi.mock('driver.js', () => ({ driver: (config: typeof mock.config) => {
  mock.create(); mock.config = config;
  return { destroy: () => { mock.destroy(); config.onDestroyed(); }, getActiveIndex: () => mock.index, drive: mock.drive, moveNext: mock.next };
} }));
const steps: TourStep[] = [{ element: '#a', titleKey: 'a', contentKey: 'b' }, { element: '#b', titleKey: 'c', contentKey: 'd' }];
beforeEach(() => { mock.create.mockClear(); mock.destroy.mockClear(); mock.index = 0; });

it('uses latest callbacks without recreating the driver, and destroys explicit close as skip', () => {
  const old = vi.fn(), latest = vi.fn(), complete = vi.fn();
  const { rerender, result, unmount } = renderHook(({ skip }) => useTour({ steps, onSkip: skip, onComplete: complete }), { initialProps: { skip: old } });
  const start = result.current.startTour;
  rerender({ skip: latest });
  expect(mock.create).toHaveBeenCalledTimes(1);
  expect(result.current.startTour).toBe(start);
  act(() => mock.config.onDestroyStarted());
  expect(mock.destroy).toHaveBeenCalledTimes(1);
  expect(latest).toHaveBeenCalledTimes(1);
  expect(old).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  unmount();
  expect(complete).not.toHaveBeenCalled();
});

it('marks completion only for the last next button, and never on unmount', () => {
  const complete = vi.fn(), skip = vi.fn();
  const { unmount } = renderHook(() => useTour({ steps, onComplete: complete, onSkip: skip }));
  mock.index = 1;
  act(() => mock.config.onNextClick());
  expect(complete).toHaveBeenCalledTimes(1);
  expect(skip).not.toHaveBeenCalled();
  unmount();
  expect(complete).toHaveBeenCalledTimes(1);
  const second = renderHook(() => useTour({ steps, onComplete: complete, onSkip: skip }));
  second.unmount();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(skip).not.toHaveBeenCalled();
});
