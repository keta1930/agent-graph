import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InputArea from './InputArea';
import ModeSelector from './ModeSelector';
import { I18nProvider } from '../../../i18n/I18nContext';
import { useModelStore } from '../../../store/modelStore';
import { useGraphEditorStore } from '../../../store/graphEditorStore';
import { useMCPStore } from '../../../store/mcpStore';
import { useConversationStore } from '../../../store/conversationStore';

vi.mock('../controls/ModelSelector', () => ({ default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <input aria-label="model" value={value} onChange={event => onChange(event.target.value)} /> }));
vi.mock('../controls/GraphSelector', () => ({ default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <input aria-label="graph" value={value} onChange={event => onChange(event.target.value)} /> }));
vi.mock('../controls/MCPToolSelector', () => ({ default: ({ selectedMCPServers, onToggleMCPServer }: { selectedMCPServers: Record<string, boolean>; onToggleMCPServer: (name: string, enabled: boolean) => void }) => <button onClick={() => onToggleMCPServer('tool', !selectedMCPServers.tool)}>MCP:{String(selectedMCPServers.tool)}</button> }));
vi.mock('../controls/SystemPromptToggle', () => ({ default: ({ onToggle }: { onToggle: () => void }) => <button onClick={onToggle}>system prompt</button> }));
vi.mock('../controls/AgentPicker', () => ({ default: () => null }));
vi.mock('../controls/SystemToolSelector', () => ({ default: () => null }));
vi.mock('../controls/PromptSelector', () => ({ default: () => null }));
vi.mock('../controls/MaxIterationsConfig', () => ({ default: () => null }));
vi.mock('../controls/ProjectSelector', () => ({ default: () => null }));

beforeEach(() => {
  useModelStore.setState({ models: [], fetchModels: vi.fn().mockResolvedValue(undefined) });
  useGraphEditorStore.setState({ graphs: [], fetchGraphs: vi.fn().mockResolvedValue(undefined) });
  useMCPStore.setState({ configLoaded: true, config: { mcpServers: { tool: { command: 'test', args: [], autoApprove: [], disabled: false, timeout: 60, transportType: 'stdio' } } }, status: {}, fetchConfig: vi.fn().mockResolvedValue(undefined), fetchStatus: vi.fn().mockResolvedValue(undefined) });
  useConversationStore.setState({ currentMode: 'agent' });
});
function keyboard(textarea: HTMLElement) { fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true }); }
function deferred() { let resolve!: () => void; let reject!: (error: Error) => void; const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
describe('chat input editing and submission', () => {
  it('preserves same-conversation config when detail/MCP refresh and clears A draft/files for B', async () => {
    const submit = vi.fn();
    const { rerender, container } = render(<I18nProvider><InputArea mode="agent" conversationId="A" inheritedConfig={{ selectedModel: 'old', selectedMCPServers: ['tool'] }} onSendMessage={submit} /></I18nProvider>);
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'draft A' } });
    fireEvent.change(screen.getByLabelText('model'), { target: { value: 'edited' } });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['a'], 'a.txt')] } });
    rerender(<I18nProvider><InputArea mode="agent" conversationId="A" inheritedConfig={{ selectedModel: 'server' }} onSendMessage={submit} /></I18nProvider>);
    act(() => useMCPStore.setState({ config: { mcpServers: { other: { command: 'test', args: [], autoApprove: [], disabled: false, timeout: 60, transportType: 'stdio' } } } }));
    await waitFor(() => expect(screen.getByLabelText('model')).toHaveValue('edited'));
    expect(textarea).toHaveValue('draft A');
    expect(await screen.findByText('MCP:undefined')).toBeInTheDocument();
    rerender(<I18nProvider><InputArea mode="agent" conversationId="B" inheritedConfig={{ selectedModel: 'B-model' }} onSendMessage={submit} /></I18nProvider>);
    expect(container.querySelector('textarea')).toHaveValue('');
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'B text' } });
    await act(async () => { keyboard(container.querySelector('textarea')!); });
    expect(submit).toHaveBeenCalledWith('B text', expect.not.objectContaining({ files: expect.anything() }));
  });
  it.each(['input', 'new'] as const)('%s rejects invalid shortcut and IME, submits once, retains failed draft and attachments', async kind => {
    const pending = deferred(); const submit = vi.fn().mockReturnValue(pending.promise);
    const component = kind === 'input' ? <InputArea mode="agent" conversationId="A" onSendMessage={submit} /> : <ModeSelector onModeSelect={() => undefined} onStartConversation={submit} />;
    const { container } = render(<I18nProvider>{component}</I18nProvider>);
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'keep draft' } });
    keyboard(textarea); expect(submit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('model'), { target: { value: 'model' } });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['a'], 'a.txt')] } });
    fireEvent.compositionStart(textarea); keyboard(textarea); expect(submit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(textarea);
    act(() => { keyboard(textarea); keyboard(textarea); });
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][1].files[0].name).toBe('a.txt');
    await act(async () => { pending.reject(new Error('500')); });
    expect(textarea).toHaveValue('keep draft');
    submit.mockResolvedValue(undefined);
    await act(async () => { keyboard(textarea); });
    expect(submit.mock.calls[1][1].files[0].name).toBe('a.txt');
    expect(textarea).toHaveValue('');
  });
  it('uses graph selection and disabled state for shortcut validation', async () => {
    const submit = vi.fn();
    const { container, rerender } = render(<I18nProvider><InputArea mode="graph" onSendMessage={submit} /></I18nProvider>);
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'graph text' } }); keyboard(textarea);
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('graph'), { target: { value: 'graph' } });
    rerender(<I18nProvider><InputArea mode="graph" disabled onSendMessage={submit} /></I18nProvider>);
    keyboard(textarea); expect(submit).not.toHaveBeenCalled();
    rerender(<I18nProvider><InputArea mode="graph" onSendMessage={submit} /></I18nProvider>);
    await act(async () => keyboard(textarea));
    expect(submit).toHaveBeenCalledWith('graph text', { graph_name: 'graph' });
  });
});
