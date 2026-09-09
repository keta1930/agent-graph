import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, expect, it, vi } from 'vitest';
import ModelForm from './ModelForm';

vi.mock('../../i18n/hooks', () => ({ useT: () => (key: string) => key }));
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })) });
});
const model = { name: 'A', base_url: 'https://example.test', model: 'model-a', api_key: 'secret', temperature: 1.2 };

it('preserves failed submissions and the same-record draft, while resetting another record', async () => {
  const submit = vi.fn().mockRejectedValue(new Error('failed'));
  const props = { visible: true, onClose: vi.fn(), onSubmit: submit, title: 'Edit' };
  const { rerender } = render(<ModelForm {...props} initialValues={model} />);
  const name = screen.getByLabelText('pages.modelManager.form.modelName');
  fireEvent.change(name, { target: { value: 'Draft' } });
  rerender(<ModelForm {...props} initialValues={{ ...model, temperature: 0.5 }} />);
  expect(name).toHaveValue('Draft');
  fireEvent.click(screen.getByText('common.submit'));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(name).toHaveValue('Draft');
  expect(submit.mock.calls[0][0]).not.toHaveProperty('api_key');
  expect(submit.mock.calls[0][0].temperature).toBe(1.2);
  rerender(<ModelForm {...props} initialValues={{ ...model, name: 'B', temperature: undefined }} />);
  expect(screen.getByLabelText('pages.modelManager.form.modelName')).toHaveValue('B');
  rerender(<ModelForm {...props} visible={false} initialValues={model} />);
  rerender(<ModelForm {...props} initialValues={model} />);
  expect(screen.getByLabelText('pages.modelManager.form.modelName')).toHaveValue('A');
});

it('submits once while pending, and clears only after success', async () => {
  let resolve!: () => void;
  const submit = vi.fn(() => new Promise<void>(done => { resolve = done; }));
  render(<ModelForm visible onClose={vi.fn()} onSubmit={submit} initialValues={model} title="Edit" />);
  const button = screen.getByText('common.submit');
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText('pages.modelManager.form.modelName')).toHaveValue('A');
  await act(async () => resolve());
  expect(screen.getByLabelText('pages.modelManager.form.modelName')).toHaveValue('');
});
