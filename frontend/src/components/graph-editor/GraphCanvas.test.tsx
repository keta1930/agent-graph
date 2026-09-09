import { act, render } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactFlowProps } from 'reactflow';
import GraphCanvas from './GraphCanvas';
import { useGraphEditorStore as store } from '../../store/graphEditorStore';
import { invalidateSession } from '../../utils/authSession';
import * as service from '../../services/graphService';
import ArcEdge from './edges/ArcEdge';
import ButtonEdge from './edges/ButtonEdge';
import { fireEvent, screen } from '@testing-library/react';
import { Position } from 'reactflow';
const flow = vi.hoisted(() => ({ props: {} as ReactFlowProps }));
vi.mock('reactflow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('reactflow')>()),
  default: (props: ReactFlowProps) => {
    flow.props = props;
    return <div data-testid="flow" />;
  },
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => (
    <foreignObject>{children}</foreignObject>
  ),
}));
vi.mock('./AgentNodeComponent', () => ({ default: () => null }));
vi.mock('./canvas/BackgroundControls', () => ({
  default: () => null,
  CanvasBackground: () => null,
}));
vi.mock('../../services/graphService', () => ({
  createGraph: vi.fn(),
  getGraphs: vi.fn(),
  getGraph: vi.fn(),
}));
beforeEach(() => {
  invalidateSession();
  vi.mocked(service.createGraph).mockResolvedValue({ status: 'success', message: '' });
  vi.mocked(service.getGraphs).mockResolvedValue(['fixture']);
  store.getState().createNewGraph('fixture', '');
});
it('persists at most two position updates for 100 nodes and 50 drag moves, preserving stationary data', async () => {
  for (let index = 0; index < 100; index++) store.getState().addNode({ name: `node-${index}` });
  const id = store.getState().currentGraph!.nodes[0].id!;
  render(<GraphCanvas />);
  const stationary = flow.props.nodes![1];
  let positionWrites = 0;
  const unsubscribe = store.subscribe((next, old) => {
    if (next.currentGraph?.nodes !== old.currentGraph?.nodes) positionWrites++;
  });
  for (let move = 1; move <= 50; move++)
    act(() =>
      flow.props.onNodesChange!([
        { type: 'position', id, position: { x: move * 10, y: move }, dragging: true },
      ])
    );
  expect(positionWrites).toBe(0);
  expect(flow.props.nodes![1]).toBe(stationary);
  expect(store.getState().currentGraph!.nodes[0].position).toEqual({ x: 100, y: 100 });
  // 尚未收到 drag-stop 时保存也必须包含最新可见位置。
  await act(async () => {
    await store.getState().saveGraph();
  });
  expect(service.createGraph).toHaveBeenCalledWith(
    expect.objectContaining({
      nodes: expect.arrayContaining([
        expect.objectContaining({ name: 'node-0', position: { x: 500, y: 50 } }),
      ]),
    })
  );
  act(() =>
    flow.props.onNodeDragStop!({} as React.MouseEvent, flow.props.nodes![0], flow.props.nodes!)
  );
  expect(positionWrites).toBe(1);
  expect(flow.props.nodes![1].data).toBe(stationary.data);
  expect(positionWrites).toBeLessThanOrEqual(2);
  unsubscribe();
  const saved = vi.mocked(service.createGraph).mock.calls[0][0];
  vi.mocked(service.getGraph).mockResolvedValue(saved);
  await act(async () => {
    await store.getState().loadGraph('fixture');
  });
  expect(store.getState().currentGraph!.nodes[0].position).toEqual({ x: 500, y: 50 });
});
it('selection and keyboard node removal stay in sync with canonical topology', () => {
  store.getState().addNode({ name: 'a', output_nodes: ['b'] });
  store.getState().addNode({ name: 'b', input_nodes: ['a'] });
  const [a, b] = store.getState().currentGraph!.nodes;
  render(<GraphCanvas />);
  act(() => store.getState().selectNode(a.id!));
  expect(flow.props.nodes!.filter((node) => node.selected).map((node) => node.id)).toEqual([a.id]);
  expect(flow.props.nodes![0].data.selected).toBe(true);
  act(() => flow.props.onNodesChange!([{ type: 'remove', id: a.id! }]));
  expect(store.getState().selectedNode).toBeNull();
  expect(store.getState().currentGraph!.nodes.map((node) => node.id)).toEqual([b.id]);
  expect(store.getState().currentGraph!.nodes[0].input_nodes).toEqual([]);
  expect(flow.props.edges).toEqual([]);
});
it.each([
  ['handoff', ArcEdge],
  ['regular', ButtonEdge],
] as const)('%s delete button removes the persisted connection', (_name, Component) => {
  store.getState().addNode({ name: 'a', output_nodes: ['b'], handoffs: 2 });
  store.getState().addNode({ name: 'b', input_nodes: ['a'] });
  const [a, b] = store.getState().currentGraph!.nodes;
  render(
    <svg>
      <Component
        id="edge"
        source={a.id!}
        target={b.id!}
        sourceX={0}
        sourceY={0}
        targetX={100}
        targetY={100}
        sourcePosition={Position.Right}
        targetPosition={Position.Left}
      />
    </svg>
  );
  fireEvent.click(screen.getByRole('button'));
  expect(store.getState().currentGraph!.nodes[0].output_nodes).toEqual([]);
  expect(store.getState().currentGraph!.nodes[1].input_nodes).toEqual([]);
});
it('keyboard handoff edge removal persists', () => {
  store.getState().addNode({ name: 'a', output_nodes: ['b'], handoffs: 2 });
  store.getState().addNode({ name: 'b', input_nodes: ['a'] });
  render(<GraphCanvas />);
  expect(flow.props.edges![0].type).toBe('arc');
  act(() => flow.props.onEdgesChange!([{ type: 'remove', id: flow.props.edges![0].id }]));
  expect(store.getState().currentGraph!.nodes[0].output_nodes).toEqual([]);
  expect(store.getState().currentGraph!.nodes[1].input_nodes).toEqual([]);
});
it('persists discrete keyboard position changes without waiting for a drag callback', () => {
  store.getState().addNode({ name: 'a' });
  const id = store.getState().currentGraph!.nodes[0].id!;
  render(<GraphCanvas />);
  act(() =>
    flow.props.onNodesChange!([
      { type: 'position', id, position: { x: 120, y: 100 }, dragging: false },
    ])
  );
  expect(store.getState().currentGraph!.nodes[0].position).toEqual({ x: 120, y: 100 });
});
