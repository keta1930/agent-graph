import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import MCPJsonEditor from './MCPJsonEditor';

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea value={value} onChange={event => onChange(event.target.value)} />
  ),
}));
vi.mock('../../i18n/hooks', () => ({ useT: () => (key: string) => key }));

const url = 'https://example.com/mcp';
const servers = {
  remote: { url },
  events: { type: 'SSE', transportType: 'stdio', url },
  local: { command: 'uvx', args: ['example'], env: { MODE: 'dev' } },
  dashed: { type: 'streamable-http', url },
  underscored: { type: 'streamable_http', url },
  camel: { transportType: 'streamableHttp', url },
  uppercase: { transportType: 'STREAMABLE-HTTP', url },
  both: { transportType: 'stdio', command: 'unused', url },
};
const defaults = { args: [], autoApprove: [], disabled: false, timeout: 60 };
const http = { ...defaults, transportType: 'streamable_http', url };
const expected = { mcpServers: {
  remote: http, events: { ...defaults, transportType: 'sse', url },
  local: { ...defaults, ...servers.local, transportType: 'stdio' },
  dashed: http, underscored: http, camel: http, uppercase: http, both: http,
} };

function openEditor(draft: unknown) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<MCPJsonEditor config={{ mcpServers: {} }} loading={false} onSave={onSave} />);
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox');
  fireEvent.change(editor, { target: { value: JSON.stringify(draft) } });
  return { editor, onSave };
}

it('formats a pasted server map locally and can format the canonical result again', () => {
  const { editor, onSave } = openEditor(servers);
  const format = screen.getByText('pages.mcpManager.jsonEditor.formatAndClean');
  fireEvent.click(format);
  expect(JSON.parse(editor.value)).toEqual(expected);
  const formatted = editor.value;
  fireEvent.click(format);
  expect(editor.value).toBe(formatted);
  expect(onSave).not.toHaveBeenCalled();
});

it.each([servers, { mcpServers: servers }])('saves external configurations directly', async draft => {
  const { onSave } = openEditor(draft);
  fireEvent.click(screen.getByText('pages.mcpManager.jsonEditor.saveConfig'));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expected));
});

it.each([{ type: 'sse' }, { args: ['example'] }, { transportType: 'unknown', url }])(
  'retains an invalid draft and allows saving after correction', async server => {
    const draft = { mcpServers: { example: server } };
    const { editor, onSave } = openEditor(draft);
    fireEvent.click(screen.getByText('pages.mcpManager.jsonEditor.formatAndClean'));
    expect(editor.value).toBe(JSON.stringify(draft));
    expect(screen.getByText('pages.mcpManager.jsonEditor.formatFailed')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: JSON.stringify({ mcpServers: servers }) } });
    fireEvent.click(screen.getByText('pages.mcpManager.jsonEditor.saveConfig'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expected));
  },
);
