import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import GlobalNotification from './GlobalNotification';

afterEach(() => vi.useRealTimers());

it('exits once, stays exiting across parent updates, and clears pending timers', () => {
  vi.useFakeTimers();
  const remove = vi.fn();
  const notification = { id: 'a', type: 'info' as const, title: 'Notice', duration: 1000 };
  const { rerender, unmount } = render(<GlobalNotification notifications={[notification]} onRemove={remove} />);
  fireEvent.click(screen.getByRole('button'));
  rerender(<GlobalNotification notifications={[{ ...notification }]} onRemove={remove} />);
  expect(screen.getByText('Notice').closest('.global-notification')).toHaveClass('hidden');
  act(() => vi.advanceTimersByTime(2000));
  expect(remove).toHaveBeenCalledTimes(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps duration zero open and cancels auto-close on unmount', () => {
  vi.useFakeTimers();
  const remove = vi.fn();
  const { unmount } = render(<GlobalNotification notifications={[{ id: 'a', type: 'success', title: 'Notice', duration: 0 }]} onRemove={remove} />);
  act(() => vi.advanceTimersByTime(10000));
  expect(remove).not.toHaveBeenCalled();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
