import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, expect, it, vi } from 'vitest';
import MCPServerForm from './MCPServerForm';

vi.mock('../../i18n/hooks', () => ({ useT: () => (key: string) => key }));
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })) });
});
const config = { disabled: false, timeout: 60, args: ['run'], autoApprove: [], transportType: 'stdio' as const, command: 'node', env: { TOKEN: 'private' } };

it.each([
  ['streamable_http', 'transportHttp', 'httpUrl'],
  ['sse', 'transportSse', 'sseUrl'],
])('submits a new %s server after switching from stdio', async (transport, option, urlLabel) => {
  const submit = vi.fn().mockResolvedValue(undefined);
  render(<MCPServerForm visible onClose={vi.fn()} onSubmit={submit} title="Add" />);
  fireEvent.change(screen.getByLabelText('pages.mcpManager.form.serverName'), { target: { value: 'remote' } });
  fireEvent.change(screen.getByLabelText('pages.mcpManager.form.args'), { target: { value: 'stdio-only' } });
  fireEvent.mouseDown(screen.getByRole('combobox'));
  fireEvent.click(screen.getByText('pages.mcpManager.form.' + option));
  const url = 'https://example.com/mcp';
  fireEvent.change(await screen.findByLabelText('pages.mcpManager.form.' + urlLabel), { target: { value: url } });
  fireEvent.click(screen.getByText('common.submit'));
  await waitFor(() => expect(submit).toHaveBeenCalledWith('remote', {
    transportType: transport, url, args: [], autoApprove: [], disabled: false, timeout: 60, env: {},
  }));
});

it('keeps a failed draft, clears absent environment fields on record changes, and preserves blank env values', async () => {
  const submit = vi.fn().mockRejectedValue(new Error('failed'));
  const props = { visible: true, onClose: vi.fn(), onSubmit: submit, title: 'Edit' };
  const { rerender } = render(<MCPServerForm {...props} initialName="A" initialValues={config} />);
  const env = screen.getByLabelText(/pages.mcpManager.form.envVars/);
  fireEvent.change(env, { target: { value: 'EMPTY=\nOTHER=a=b' } });
  rerender(<MCPServerForm {...props} initialName="A" initialValues={{ ...config }} />);
  expect(env).toHaveValue('EMPTY=\nOTHER=a=b');
  fireEvent.click(screen.getByText('common.submit'));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0][1].env).toEqual({ EMPTY: '', OTHER: 'a=b' });
  expect(env).toHaveValue('EMPTY=\nOTHER=a=b');
  rerender(<MCPServerForm {...props} initialName="B" initialValues={{ ...config, env: undefined }} />);
  expect(screen.getByLabelText(/pages.mcpManager.form.envVars/)).toHaveValue('');
});
