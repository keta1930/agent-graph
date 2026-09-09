import { describe, expect, it } from 'vitest';
import { getErrorMessage } from './errors';

describe('getErrorMessage', () => {
  it.each([
    [new Error('Connection failed'), 'Connection failed'],
    [{ response: { data: { detail: 'Access denied' } }, message: 'Request failed' }, 'Access denied'],
    [{ response: { data: { message: 'Already exists' } } }, 'Already exists'],
    [{ detail: { message: 'Invalid graph' } }, 'Invalid graph'],
    [{ message: 'Task failed' }, 'Task failed'],
  ])('extracts a known error message', (error, expected) => {
    expect(getErrorMessage(error)).toBe(expected);
  });

  it.each([null, undefined, { token: 'private-value' }, { message: {} }, { message: ' ' }, 500])(
    'uses fallback for unknown values without serializing them', (error) => {
      expect(getErrorMessage(error, 'Failed')).toBe('Failed');
    },
  );
});
