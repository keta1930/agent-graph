import { beforeEach, expect, it, vi } from 'vitest';
import { useGraphEditorStore as store } from './graphEditorStore';
import * as service from '../services/graphService';
import { invalidateSession } from '../utils/authSession';
vi.mock('../services/graphService', () => ({
  createGraph: vi.fn(),
  getGraphs: vi.fn(),
  getGraph: vi.fn(),
  deleteGraph: vi.fn(),
  getGraphVersions: vi.fn(),
  getGraphVersion: vi.fn(),
  createGraphVersion: vi.fn(),
  deleteGraphVersion: vi.fn(),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  invalidateSession();
  vi.mocked(service.getGraphs).mockResolvedValue(['A']);
  vi.mocked(service.createGraph).mockResolvedValue({ status: 'success', message: '' });
  store.getState().createNewGraph('A', 'initial');
});
it('confirms only the saved snapshot when new edits arrive during save', async () => {
  const pending = deferred<Awaited<ReturnType<typeof service.createGraph>>>();
  vi.mocked(service.createGraph).mockReturnValue(pending.promise);
  const saving = store.getState().saveGraph();
  store.getState().updateGraphProperties({ description: 'later' });
  pending.resolve({ status: 'success', message: '' });
  await saving;
  expect(store.getState().dirty).toBe(true);
  expect(store.getState().originalGraph?.description).toBe('initial');
});
it('rejects failed saves and deletes without clearing edits', async () => {
  vi.mocked(service.createGraph).mockRejectedValue(new Error('save failed'));
  await expect(store.getState().saveGraph()).rejects.toThrow('save failed');
  expect(store.getState().dirty).toBe(true);
  vi.mocked(service.deleteGraph).mockRejectedValue(new Error('delete failed'));
  await expect(store.getState().deleteGraph('A')).rejects.toThrow('delete failed');
  expect(store.getState().currentGraph?.name).toBe('A');
});
it('does not let an old save overwrite a newly selected graph', async () => {
  const pending = deferred<Awaited<ReturnType<typeof service.createGraph>>>();
  vi.mocked(service.createGraph).mockReturnValue(pending.promise);
  const saving = store.getState().saveGraph();
  store.getState().createNewGraph('B', 'other');
  pending.resolve({ status: 'success', message: '' });
  await saving.catch(() => {});
  expect(store.getState().currentGraph?.name).toBe('B');
  expect(store.getState().dirty).toBe(true);
  expect(store.getState().originalGraph?.name).not.toBe('A');
});
it('atomically migrates topology and exact template node tokens on rename', async () => {
  store.getState().addNode({
    name: 'a',
    input_nodes: ['start'],
    output_nodes: ['b'],
    user_prompt: '{{ a : 2 | b:all }} a {{ab}}',
    handoffs: 2,
  });
  store.getState().addNode({ name: 'b', input_nodes: ['a'], output_nodes: ['a'] });
  store.getState().updateGraphProperties({ end_template: '{{a}} {{a:all}}' });
  const id = store.getState().currentGraph!.nodes[0].id!;
  store.getState().updateNode(id, { name: 'renamed' });
  const graph = store.getState().currentGraph!;
  expect(graph.nodes[1].input_nodes).toEqual(['renamed']);
  expect(graph.nodes[1].output_nodes).toEqual(['renamed']);
  expect(graph.nodes[0].user_prompt).toBe('{{ renamed : 2 | b:all }} a {{ab}}');
  expect(graph.end_template).toBe('{{renamed}} {{renamed:all}}');
  for (const name of ['b', '', 'start', 'end'])
    expect(() => store.getState().updateNode(id, { name })).toThrow();
  await store.getState().saveGraph();
  vi.mocked(service.getGraph).mockResolvedValue(vi.mocked(service.createGraph).mock.calls[0][0]);
  await store.getState().loadGraph('A');
  expect(store.getState().currentGraph!.nodes[1].input_nodes).toEqual(['renamed']);
  expect(store.getState().currentGraph!.nodes[0].handoffs).toBe(2);
  expect(store.getState().currentGraph!.end_template).toBe('{{renamed}} {{renamed:all}}');
});
it('clears graph data and rejects late save ownership after logout', async () => {
  const pending = deferred<Awaited<ReturnType<typeof service.createGraph>>>();
  vi.mocked(service.createGraph).mockReturnValue(pending.promise);
  const saving = store.getState().saveGraph();
  invalidateSession();
  pending.resolve({ status: 'success', message: '' });
  await saving.catch(() => {});
  expect(store.getState().currentGraph).toBeNull();
  expect(store.getState().graphs).toEqual([]);
  expect(store.getState().loading).toBe(false);
});
it('saves JSON drafts through the shared save action, preserving later typing', async () => {
  const pending = deferred<Awaited<ReturnType<typeof service.createGraph>>>();
  vi.mocked(service.createGraph).mockReturnValue(pending.promise);
  store.getState().beginJsonEditing();
  store.getState().setJsonDraft(JSON.stringify({ name: 'A', description: 'JSON edit', nodes: [] }));
  expect(store.getState().dirty).toBe(true);
  const saving = store.getState().saveGraph();
  store.getState().setJsonDraft('{ later incomplete');
  pending.resolve({ status: 'success', message: '' });
  await saving;
  expect(service.createGraph).toHaveBeenCalledWith(
    expect.objectContaining({ description: 'JSON edit' })
  );
  expect(store.getState().dirty).toBe(true);
  expect(store.getState().jsonDraft).toBe('{ later incomplete');
  await expect(store.getState().saveGraph()).rejects.toThrow();
  expect(store.getState().jsonDraft).toBe('{ later incomplete');
});
it('does not convert an auxiliary list refresh failure into a save failure', async () => {
  vi.mocked(service.getGraphs).mockRejectedValue(new Error('list failed'));
  await expect(store.getState().saveGraph()).resolves.toBeUndefined();
  expect(store.getState().dirty).toBe(false);
  expect(store.getState().error).toBe('list failed');
});
it('ignores an old load after a new load or new graph', async () => {
  const pending = deferred<Awaited<ReturnType<typeof service.getGraph>>>();
  vi.mocked(service.getGraph).mockReturnValue(pending.promise);
  const loading = store.getState().loadGraph('old');
  store.getState().createNewGraph('new', '');
  pending.resolve({ name: 'old', description: '', nodes: [] });
  await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  expect(store.getState().currentGraph?.name).toBe('new');
});
it('deduplicates simultaneous saves', async () => {
  const pending = deferred<Awaited<ReturnType<typeof service.createGraph>>>();
  vi.mocked(service.createGraph).mockReturnValue(pending.promise);
  const first = store.getState().saveGraph();
  const second = store.getState().saveGraph();
  expect(first).toBe(second);
  expect(service.createGraph).toHaveBeenCalledTimes(1);
  pending.resolve({ status: 'success', message: '' });
  await first;
});
it('creates versions from the validated JSON draft and resets the draft session on version load', async () => {
  vi.mocked(service.createGraphVersion).mockResolvedValue({ status: 'success', message: '' });
  vi.mocked(service.getGraphVersions).mockResolvedValue({
    graph_name: 'A',
    versions: [],
    version_count: 0,
  });
  store.getState().beginJsonEditing();
  store
    .getState()
    .setJsonDraft(JSON.stringify({ name: 'A', description: 'version draft', nodes: [] }));
  await store.getState().createVersion('A', 'snapshot');
  expect(service.createGraph).toHaveBeenCalledWith(
    expect.objectContaining({ description: 'version draft' })
  );
  expect(service.createGraphVersion).toHaveBeenCalledWith('A', 'snapshot');
  const session = store.getState().editorSession;
  vi.mocked(service.getGraphVersion).mockResolvedValue({
    graph_name: 'A',
    version_id: 'v1',
    config: { name: 'A', description: 'history', nodes: [] },
  });
  vi.mocked(service.getGraph).mockResolvedValue({ name: 'A', description: 'latest', nodes: [] });
  await store.getState().loadVersion('A', 'v1');
  expect(store.getState().editorSession).toBeGreaterThan(session);
  expect(store.getState().jsonDraft).toBeNull();
  expect(store.getState().dirty).toBe(true);
  expect(store.getState().currentGraph?.description).toBe('history');
  expect(store.getState().originalGraph?.description).toBe('latest');
});
it('blocks version creation for invalid JSON and preserves the input', async () => {
  store.getState().beginJsonEditing();
  store.getState().setJsonDraft('{ invalid');
  await expect(store.getState().createVersion('A', 'snapshot')).rejects.toThrow();
  expect(service.createGraphVersion).not.toHaveBeenCalled();
  expect(store.getState().jsonDraft).toBe('{ invalid');
});
it('ignores late graph list and version responses after logout', async () => {
  const list = deferred<string[]>();
  const versions = deferred<Awaited<ReturnType<typeof service.getGraphVersions>>>();
  vi.mocked(service.getGraphs).mockReturnValue(list.promise);
  vi.mocked(service.getGraphVersions).mockReturnValue(versions.promise);
  const loadingList = store.getState().fetchGraphs();
  const loadingVersions = store.getState().fetchVersions('A');
  invalidateSession();
  list.resolve(['private']);
  versions.resolve({
    graph_name: 'A',
    versions: [{ version_id: 'secret', commit_message: 'private', created_at: '', size: 1 }],
    version_count: 1,
  });
  await Promise.all([loadingList, loadingVersions]);
  expect(store.getState().graphs).toEqual([]);
  expect(store.getState().versions).toEqual([]);
});
it('keeps both sides of property-panel connection edits consistent', () => {
  store.getState().addNode({ name: 'a' });
  store.getState().addNode({ name: 'b' });
  const [a, b] = store.getState().currentGraph!.nodes;
  store.getState().updateNode(a.id!, { output_nodes: ['b'] });
  expect(store.getState().currentGraph!.nodes[1].input_nodes).toEqual(['a']);
  store.getState().updateNode(b.id!, { input_nodes: [] });
  expect(store.getState().currentGraph!.nodes[0].output_nodes).toEqual([]);
});
