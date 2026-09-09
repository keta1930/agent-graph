import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NodePropertiesPanel from './NodePropertiesPanel';
import { useGraphEditorStore as store } from '../../store/graphEditorStore';
import { invalidateSession } from '../../utils/authSession';
const resources = vi.hoisted(() => ({
  models: [],
  agents: [],
  config: { mcpServers: {} },
  fetchModels: vi.fn(),
  fetchAgents: vi.fn(),
  fetchConfig: vi.fn(),
}));
vi.mock('../../store/modelStore', () => ({
  useModelStore: (selector: (state: typeof resources) => unknown) => selector(resources),
}));
vi.mock('../../store/agentStore', () => ({
  useAgentStore: (selector: (state: typeof resources) => unknown) => selector(resources),
}));
vi.mock('../../store/mcpStore', () => ({
  useMCPStore: (selector: (state: typeof resources) => unknown) => selector(resources),
}));
vi.mock('../../services/systemToolsService', () => ({
  listSystemTools: async () => ({ categories: [] }),
}));
vi.mock('../../services/promptService', () => ({
  promptService: { listPrompts: async () => ({ success: true, data: { prompts: [] } }) },
}));
vi.mock('../../i18n/hooks', () => ({ useT: () => (key: string) => key }));
vi.mock('../common/SystemToolTreeSelector', () => ({ default: () => null }));
vi.mock('../common/MCPSelector', () => ({ default: () => null }));
vi.mock('../../services/graphService', () => ({}));
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
  invalidateSession();
  store.getState().createNewGraph('A', '');
  store.getState().addNode({ name: 'a', output_nodes: ['b'] });
  store.getState().addNode({ name: 'b', input_nodes: ['a'] });
  store.getState().selectNode(store.getState().currentGraph!.nodes[0].id!);
});
it('stages rename input until blur and atomically migrates topology', async () => {
  await act(async () => {
    render(<NodePropertiesPanel />);
  });
  const input = screen.getByPlaceholderText(
    'components.graphEditor.nodePropertiesPanel.nodeNamePlaceholder'
  );
  fireEvent.change(input, { target: { value: 'renamed' } });
  expect(store.getState().currentGraph!.nodes[0].name).toBe('a');
  expect(store.getState().currentGraph!.nodes[1].input_nodes).toEqual(['a']);
  fireEvent.blur(input);
  expect(store.getState().currentGraph!.nodes[0].name).toBe('renamed');
  expect(store.getState().currentGraph!.nodes[1].input_nodes).toEqual(['renamed']);
});
it('rejects conflicting names and Escape cancels a staged rename', async () => {
  await act(async () => {
    render(<NodePropertiesPanel />);
  });
  const input = screen.getByPlaceholderText(
    'components.graphEditor.nodePropertiesPanel.nodeNamePlaceholder'
  );
  fireEvent.change(input, { target: { value: 'b' } });
  fireEvent.blur(input);
  expect(store.getState().currentGraph!.nodes[0].name).toBe('a');
  await waitFor(() =>
    expect(
      screen.getByText('components.graphEditor.nodePropertiesPanel.nodeNameConflict')
    ).toBeInTheDocument()
  );
  fireEvent.change(input, { target: { value: 'draft' } });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(input).toHaveValue('a');
  expect(store.getState().currentGraph!.nodes[0].name).toBe('a');
});
