import { beforeEach, expect, it, vi } from 'vitest';
import api from './api';
import { createGraph, getGraph } from './graphService';
import type { BackendGraphConfig } from '../types/graph';
import { parseGraphConfig } from '../utils/graphEditorModel';
import { useGraphEditorStore } from '../store/graphEditorStore';
vi.mock('./api', () => ({ default: { post: vi.fn(), get: vi.fn() } }));
beforeEach(() => { vi.mocked(api.post).mockResolvedValue({ data: { status: 'success' } }); });
it('preserves URLs, comments, whitespace and Unicode in every graph string', async () => {
  const literal = ' https://example.test/a // code\n\t/* literal */ 中文 😀 ';
  const graph: BackendGraphConfig = {
    name: 'test',
    description: literal,
    end_template: literal,
    nodes: [
      {
        name: 'a',
        description: literal,
        is_subgraph: false,
        mcp_servers: [],
        system_prompt: literal,
        user_prompt: literal,
        input_nodes: ['start'],
        output_nodes: ['end'],
        output_enabled: true,
      },
    ],
  };
  const before = structuredClone(graph);
  await createGraph(graph);
  expect(api.post).toHaveBeenCalledWith(
    '/graphs',
    expect.objectContaining({
      description: literal,
      end_template: literal,
      nodes: [
        expect.objectContaining({
          description: literal,
          system_prompt: literal,
          user_prompt: literal,
        }),
      ],
    })
  );
  expect(graph).toEqual(before);
});

it('round-trips literal text through the serialized request and graph read', async () => {
  const literal = 'https://example.test/x\n\t/* code */ // keep 中文 😀';
  vi.mocked(api.post).mockImplementation(async (_path, body) => {
    vi.mocked(api.get).mockResolvedValue({ data: JSON.parse(JSON.stringify(body)) });
    return { data: { status: 'success', message: '' } };
  });
  const graph: BackendGraphConfig = {
    name: 'roundtrip',
    description: literal,
    end_template: literal,
    nodes: [
      {
        name: 'a',
        model_name: 'test',
        is_subgraph: false,
        mcp_servers: [],
        input_nodes: ['start'],
        output_nodes: ['end'],
        system_prompt: literal,
        user_prompt: literal,
        output_enabled: true,
      },
    ],
  };
  await createGraph(graph);
  const loaded = await getGraph(graph.name);
  expect(loaded.description).toBe(literal);
  expect(loaded.end_template).toBe(literal);
  expect(loaded.nodes[0].system_prompt).toBe(literal);
  expect(loaded.nodes[0].user_prompt).toBe(literal);
});

it.each([undefined, null, 1, 3, 50, 200])('saves unset graph limit as null and preserves explicit value %s', async limit => {
  const graph = parseGraphConfig({
    name: 'agent-graph', nodes: [{ name: 'worker', agent_name: 'agent', max_iterations: limit }],
  });
  const before = structuredClone(graph);
  await createGraph(graph);
  const submitted = JSON.parse(JSON.stringify(vi.mocked(api.post).mock.lastCall?.[1]));
  expect(submitted.nodes[0].max_iterations).toBe(limit ?? null);
  expect(graph).toEqual(before);
});

it('keeps an inherited graph action limit when the editor loads and saves an existing Agent node', async () => {
  const persisted = {
    name: 'inherited', nodes: [{ name: 'worker', agent_name: 'agent', max_iterations: null }],
  };
  vi.mocked(api.get).mockImplementation(async url => ({ data: url === '/graphs' ? ['inherited'] : persisted }));
  const editor = useGraphEditorStore.getState();
  await editor.loadGraph('inherited');
  await editor.saveGraph();
  const submitted = JSON.parse(JSON.stringify(vi.mocked(api.post).mock.lastCall?.[1]));
  expect(submitted.nodes[0]).toMatchObject({ agent_name: 'agent', max_iterations: null });
  expect(useGraphEditorStore.getState().dirty).toBe(false);
  editor.closeGraph();
});
