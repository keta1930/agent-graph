import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import GraphEditor from './GraphEditor';
import { useGraphEditorStore as store } from '../store/graphEditorStore';
import { invalidateSession } from '../utils/authSession';
import * as service from '../services/graphService';
const ui = vi.hoisted(() => ({ confirm: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    App: { useApp: () => ({ modal: { confirm: ui.confirm } }) },
    message: { success: ui.success, error: ui.error },
  };
});
vi.mock('../i18n/hooks', () => ({ useT: () => (key: string) => key }));
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="JSON" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock('../components/graph-editor/GraphCanvas', () => ({ default: () => <div>canvas</div> }));
vi.mock('../components/graph-editor/NodePropertiesPanel', () => ({ default: () => null }));
vi.mock('../components/graph-editor/AddNodeModal', () => ({ default: () => null }));
vi.mock('../components/graph-editor/GraphVersionManager', () => ({ default: () => null }));
vi.mock('../components/graph-editor/GraphListView', () => ({
  default: () => <div>graph list</div>,
}));
vi.mock('../components/graph-editor/CreateGraphModal', () => ({ default: () => null }));
vi.mock('../components/graph-editor/GraphSettingsModal', () => ({ default: () => null }));
vi.mock('../components/graph-editor/ReadmeModal', () => ({ default: () => null }));
vi.mock('../services/graphService', () => ({
  createGraph: vi.fn(),
  getGraphs: vi.fn(),
  getGraph: vi.fn(),
}));
const resources = vi.hoisted(() => ({
  fetchConfig: vi.fn().mockResolvedValue(undefined),
  fetchStatus: vi.fn().mockResolvedValue(undefined),
  fetchModels: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../store/mcpStore', () => ({
  useMCPStore: (selector: (value: typeof resources) => unknown) => selector(resources),
}));
vi.mock('../store/modelStore', () => ({
  useModelStore: (selector: (value: typeof resources) => unknown) => selector(resources),
}));
beforeEach(async () => {
  invalidateSession();
  vi.mocked(service.createGraph).mockResolvedValue({ status: 'success', message: '' });
  vi.mocked(service.getGraphs).mockResolvedValue(['A']);
  vi.mocked(service.getGraph).mockResolvedValue({ name: 'A', description: 'saved', nodes: [] });
  await store.getState().loadGraph('A');
});
async function openDraft(text: string) {
  await act(async () => {
    render(<GraphEditor />);
  });
  act(() => store.getState().beginJsonEditing());
  fireEvent.change(screen.getByLabelText('JSON'), { target: { value: text } });
}
it('enables toolbar saving for JSON edits and keeps drafts through unrelated renders', async () => {
  await openDraft(JSON.stringify({ name: 'A', description: 'edited JSON', nodes: [] }));
  act(() => store.setState({ graphs: ['A', 'B'] }));
  expect(screen.getByLabelText('JSON')).toHaveValue(
    JSON.stringify({ name: 'A', description: 'edited JSON', nodes: [] })
  );
  const save = screen.getByRole('button', { name: 'common.save' });
  expect(save).toBeEnabled();
  await act(async () => {
    fireEvent.click(save);
  });
  expect(service.createGraph).toHaveBeenCalledWith(
    expect.objectContaining({ description: 'edited JSON' })
  );
  expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
});
it('save-and-return validates the same JSON draft and only leaves after a successful save', async () => {
  await openDraft(JSON.stringify({ name: 'A', description: 'return draft', nodes: [] }));
  fireEvent.click(screen.getByRole('button', { name: 'pages.graphEditor.backToList' }));
  await act(async () => {
    await ui.confirm.mock.calls[0][0].onOk();
  });
  expect(service.createGraph).toHaveBeenCalledWith(
    expect.objectContaining({ description: 'return draft' })
  );
  expect(screen.getByText('graph list')).toBeInTheDocument();
});
it('invalid JSON or failed save blocks save-and-return and preserves the editor', async () => {
  await openDraft('{ unfinished');
  fireEvent.click(screen.getByRole('button', { name: 'pages.graphEditor.backToList' }));
  await act(async () => {
    await expect(ui.confirm.mock.calls[0][0].onOk()).rejects.toThrow();
  });
  expect(service.createGraph).not.toHaveBeenCalled();
  expect(screen.getByLabelText('JSON')).toHaveValue('{ unfinished');
  fireEvent.change(screen.getByLabelText('JSON'), {
    target: { value: JSON.stringify({ name: 'A', description: 'retry', nodes: [] }) },
  });
  vi.mocked(service.createGraph).mockRejectedValue(new Error('save failed'));
  await act(async () => {
    await expect(ui.confirm.mock.calls[0][0].onOk()).rejects.toThrow('save failed');
  });
  expect(screen.getByLabelText('JSON')).toBeInTheDocument();
  expect(ui.success).not.toHaveBeenCalled();
});
