// ReactFlow 临时坐标只在拖动结束或保存前写入图模型。
import React, { useCallback, useState, useEffect, useRef } from 'react';
import ReactFlow, { Controls, MiniMap, NodeTypes, EdgeTypes, Edge, Node, OnNodesChange, OnEdgesChange, OnConnect, applyNodeChanges, applyEdgeChanges, ConnectionLineType } from 'reactflow';
import { shallow } from 'zustand/shallow';
import 'reactflow/dist/style.css';
import { useGraphEditorStore } from '../../store/graphEditorStore';
import type { AgentNode, NodePosition } from '../../types/graph';
import AgentNodeComponent from './AgentNodeComponent';
import ButtonEdge from './edges/ButtonEdge';
import ArcEdge from './edges/ArcEdge';
import BackgroundControls, { CanvasBackground, BackgroundType } from './canvas/BackgroundControls';

const nodeTypes: NodeTypes = { agent: AgentNodeComponent };
const edgeTypes: EdgeTypes = { button: ButtonEdge, arc: ArcEdge };
type NodeData = AgentNode & { id: string; system_tools: string[]; selected: boolean; onClick: () => void };
const getEdgeStyle = (source: AgentNode): React.CSSProperties => ({ stroke: source.level == null ? '#8b7355' : ['#b85845', '#cd7f32', '#d4a574', '#a0826d', '#8b7355'][Math.max(0, Math.min(source.level, 4))], strokeWidth: 2 });
const shouldAnimateEdge = (source: AgentNode) => source.level != null;

const GraphCanvas: React.FC = () => {
  const graphNodes = useGraphEditorStore(state => state.currentGraph?.nodes);
  const selectedNode = useGraphEditorStore(state => state.selectedNode);
  const selectNode = useGraphEditorStore(state => state.selectNode);
  const removeNode = useGraphEditorStore(state => state.removeNode);
  const addConnection = useGraphEditorStore(state => state.addConnection);
  const removeConnection = useGraphEditorStore(state => state.removeConnection);
  const updateNodePositions = useGraphEditorStore(state => state.updateNodePositions);
  const registerPositionFlusher = useGraphEditorStore(state => state.registerPositionFlusher);
  const [nodes, setNodes] = useState<Node<NodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const nodesRef = useRef<Node<NodeData>[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const pendingPositions = useRef<Record<string, NodePosition>>({});
  const [backgroundType, setBackgroundType] = useState<BackgroundType>('dots');
  const flushPositions = useCallback(() => {
    const positions = pendingPositions.current;
    pendingPositions.current = {};
    updateNodePositions(positions);
  }, [updateNodePositions]);
  useEffect(() => registerPositionFlusher(flushPositions), [registerPositionFlusher, flushPositions]);

  useEffect(() => {
    const currentGraph = { nodes: graphNodes ?? [] };
    const previous = new Map(nodesRef.current.map(node => [node.id, node]));
    const selection = useGraphEditorStore.getState().selectedNode;
    const flowNodes = currentGraph.nodes.map(node => {
      const old = previous.get(node.id!);
      const data: NodeData = { ...node, id: node.id!, system_tools: node.system_tools ?? [], selected: node.id === selection, onClick: old?.data.onClick ?? (() => selectNode(node.id!)) };
      const stableData = old && shallow(old.data, data) ? old.data : data;
      const position = pendingPositions.current[node.id!] ?? node.position ?? { x: 100, y: 100 };
      if (old && old.data === stableData && old.position.x === position.x && old.position.y === position.y) return old;
      return { ...old, id: node.id!, type: 'agent', position, data: stableData, selected: node.id === selection };
    });
    nodesRef.current = flowNodes;
    setNodes(flowNodes);
    const newEdges: Edge[] = [];
    const nodeMap = new Map(currentGraph.nodes.map(n => [n.name, n]));
    const handoffConnections = new Set<string>();

    // 收集所有 handoffs 连接并创建弧线边
    currentGraph.nodes.forEach(sourceNode => {
      if (sourceNode.handoffs) {
        sourceNode.output_nodes?.forEach(outputNodeName => {
          if (outputNodeName === "end") return;
          const outputNode = nodeMap.get(outputNodeName);
          if (outputNode && sourceNode.id && outputNode.id) {
            const isUpstream = (outputNode.level !== undefined &&
                              sourceNode.level !== undefined &&
                              outputNode.level <= sourceNode.level) ||
                             (outputNode.level === undefined || sourceNode.level === undefined);

            if (isUpstream) {
              handoffConnections.add(`${sourceNode.name}->${outputNodeName}`);

              newEdges.push({
                id: `arc-${sourceNode.id}-${outputNode.id}`,
                type: 'arc',
                source: sourceNode.id as string,
                target: outputNode.id as string,
                sourceHandle: 'handoff-source',
                targetHandle: 'handoff-target',
                style: {
                  stroke: '#d4a574',
                  strokeWidth: 3,
                  strokeDasharray: '8,4',
                },
                animated: true,
                data: {
                  handoffs: sourceNode.handoffs,
                  isHandoffEdge: true
                }
              });
            }
          }
        });
      }
    });

    // 然后生成常规连接（排除已经用弧线表示的handoffs连接）
    currentGraph.nodes.forEach(targetNode => {
      targetNode.input_nodes?.forEach(inputNodeName => {
        if (inputNodeName === "start") return;

        const sourceNode = nodeMap.get(inputNodeName);
        if (sourceNode && sourceNode.id && targetNode.id) {
          const connectionKey = `${inputNodeName}->${targetNode.name}`;
          if (!handoffConnections.has(connectionKey)) {
            newEdges.push({
              id: `e-${sourceNode.id}-${targetNode.id}`,
              type: 'button',
              source: sourceNode.id,
              target: targetNode.id,
              sourceHandle: 'output',
              targetHandle: 'input',
              style: getEdgeStyle(sourceNode),
              animated: shouldAnimateEdge(sourceNode),
            });
          }
        }
      });
    });

    edgesRef.current = newEdges;
    setEdges(newEdges);
  }, [graphNodes, selectNode]);

  useEffect(() => {
    const next = nodesRef.current.map(node => {
      const selected = node.id === selectedNode;
      return node.selected === selected && node.data.selected === selected ? node : { ...node, selected, data: { ...node.data, selected } };
    });
    nodesRef.current = next;
    setNodes(next);
  }, [selectedNode]);

  const onNodesChange: OnNodesChange = useCallback(changes => {
    const next = applyNodeChanges<NodeData>(changes, nodesRef.current);
    nodesRef.current = next; setNodes(next);
    for (const change of changes) {
      if (change.type === 'position' && change.position) pendingPositions.current[change.id] = change.position;
      if (change.type === 'remove') { delete pendingPositions.current[change.id]; removeNode(change.id); }
      if (change.type === 'select') {
        if (change.selected) selectNode(change.id);
        else if (useGraphEditorStore.getState().selectedNode === change.id) selectNode(null);
      }
    }
    if (changes.some(change => change.type === 'position' && change.dragging === false)) flushPositions();
  }, [removeNode, selectNode, flushPositions]);
  const onEdgesChange: OnEdgesChange = useCallback(changes => {
    const old = edgesRef.current;
    const next = applyEdgeChanges(changes, old);
    edgesRef.current = next; setEdges(next);
    for (const edge of old) if (!next.some(item => item.id === edge.id)) removeConnection(edge.source, edge.target);
  }, [removeConnection]);
  const onConnect: OnConnect = useCallback(connection => {
    if (connection.source && connection.target && connection.sourceHandle === 'output' && connection.targetHandle === 'input') addConnection(connection.source, connection.target);
  }, [addConnection]);
  const onPaneClick = useCallback(() => selectNode(null), [selectNode]);
  const nodeColor = (node: Node<NodeData>) => {
    if (node.selected) return '#b85845';
    if (node.data.is_subgraph) return '#cd7f32';
    if (node.data.handoffs && node.data.handoffs > 1) return '#d4a574';
    if (node.data.input_nodes.includes('start')) return '#a0826d';
    if (node.data.output_nodes.includes('end')) return '#b85845';
    return '#d4c4b0';
  };

  return (
    <div style={{ 
      width: '100%', 
      height: '100%', 
      position: 'relative',
      borderRadius: '8px',
      overflow: 'hidden',
      border: '1px solid rgba(139, 115, 85, 0.15)',
      boxShadow: '0 2px 8px rgba(139, 115, 85, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.6)'
    }}>
      {/* 画布背景*/}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'linear-gradient(to bottom, #faf8f5 0%, #f5f3f0 100%)',
          zIndex: 0,
        }}
      />

      {/* 顶部装饰性渐变线 */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: '15%',
        right: '15%',
        height: '1px',
        background: 'linear-gradient(to right, transparent, rgba(139, 115, 85, 0.2) 50%, transparent)',
        zIndex: 2
      }} />

      <BackgroundControls
        backgroundType={backgroundType}
        onBackgroundTypeChange={setBackgroundType}
      />

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onNodeDragStop={flushPositions}
        onSelectionDragStop={flushPositions}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        connectionLineType={ConnectionLineType.Straight}
        defaultEdgeOptions={{
          type: 'button',
          style: { stroke: '#8b7355', strokeWidth: 2 }
        }}
        selectNodesOnDrag={false}
        connectionLineStyle={{ stroke: '#b85845', strokeWidth: 2 }}
        style={{ position: 'relative', zIndex: 1 }}
      >
        <Controls 
          style={{
            background: 'linear-gradient(to bottom, rgba(255, 255, 255, 0.9), rgba(250, 248, 245, 0.85))',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(139, 115, 85, 0.15)',
            borderRadius: '6px',
            boxShadow: '0 1px 3px rgba(139, 115, 85, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.8)',
            padding: '4px'
          }}
        />
        <MiniMap 
          nodeColor={nodeColor}
          nodeStrokeWidth={2}
          pannable
          zoomable
          style={{
            background: 'linear-gradient(to bottom, rgba(255, 255, 255, 0.9), rgba(250, 248, 245, 0.85))',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(139, 115, 85, 0.15)',
            borderRadius: '6px',
            boxShadow: '0 1px 3px rgba(139, 115, 85, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.6)',
          }}
          maskColor="rgba(250, 248, 245, 0.6)"
        />
        <CanvasBackground backgroundType={backgroundType} />
      </ReactFlow>

      <style>{`
        /* 边删除按钮 */
        .edge-button {
          width: 22px;
          height: 22px;
          background: linear-gradient(135deg, #b85845 0%, #a0826d 100%);
          border: 1px solid rgba(139, 115, 85, 0.2);
          color: #faf8f5;
          border-radius: 50%;
          cursor: pointer;
          font-size: 11px;
          line-height: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0.95;
          transition: all 0.3s cubic-bezier(0.23, 1, 0.32, 1);
          box-shadow: 0 2px 6px rgba(184, 88, 69, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.2);
          backdrop-filter: blur(4px);
        }
        
        .edge-button:hover {
          opacity: 1;
          transform: translateY(-1px) scale(1.1);
          box-shadow: 0 4px 12px rgba(184, 88, 69, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.3);
          border-color: rgba(184, 88, 69, 0.3);
        }

        .arc-edge-button {
          background: linear-gradient(135deg, #d4a574 0%, #cd7f32 100%) !important;
        }

        .arc-edge-button:hover {
          box-shadow: 0 4px 12px rgba(212, 165, 116, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.3) !important;
        }
        
        /* Agent 节点容器 */
        .react-flow__node-agent {
          background: transparent;
          border: none;
          filter: drop-shadow(0 1px 3px rgba(139, 115, 85, 0.08));
        }
        
        /* 连接点 */
        .react-flow__handle {
          width: 12px;
          height: 12px;
          background: linear-gradient(135deg, rgba(255, 255, 255, 0.95) 0%, rgba(250, 248, 245, 0.9) 100%);
          border: 2px solid rgba(139, 115, 85, 0.3);
          box-shadow: 0 1px 3px rgba(139, 115, 85, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.8);
          transition: all 0.3s cubic-bezier(0.23, 1, 0.32, 1);
          backdrop-filter: blur(4px);
        }
        
        .react-flow__handle:hover {
          background: linear-gradient(135deg, rgba(250, 248, 245, 1) 0%, rgba(245, 243, 240, 0.95) 100%);
          border-color: #b85845;
          border-width: 2.5px;
          box-shadow: 0 2px 6px rgba(184, 88, 69, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.9);
          transform: scale(1.3);
        }
        
        .react-flow__handle-top,
        .react-flow__handle-bottom {
          left: 50%;
          transform: translateX(-50%);
        }
        
        .react-flow__handle-left,
        .react-flow__handle-right {
          top: 50%;
          transform: translateY(-50%);
        }

        .react-flow__handle-top:hover,
        .react-flow__handle-bottom:hover {
          transform: translateX(-50%) scale(1.3);
        }

        .react-flow__handle-left:hover,
        .react-flow__handle-right:hover {
          transform: translateY(-50%) scale(1.3);
        }

        /* 控制面板 */
        .react-flow__controls {
          box-shadow: 0 1px 3px rgba(139, 115, 85, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.8) !important;
          border-radius: 6px !important;
        }

        .react-flow__controls-button {
          background: transparent;
          border: none;
          border-bottom: 1px solid rgba(139, 115, 85, 0.08);
          color: #8b7355;
          transition: all 0.2s ease;
          width: 32px;
          height: 32px;
          padding: 0;
        }

        .react-flow__controls-button:hover {
          background: rgba(184, 88, 69, 0.08);
          color: #b85845;
        }

        .react-flow__controls-button:last-child {
          border-bottom: none;
        }

        .react-flow__controls-button svg {
          width: 16px;
          height: 16px;
        }

        /* 小地图 */
        .react-flow__minimap {
          border-radius: 6px !important;
          overflow: hidden;
          box-shadow: 0 1px 3px rgba(139, 115, 85, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.6) !important;
        }

        .react-flow__minimap-mask {
          fill: rgba(139, 115, 85, 0.06);
          stroke: rgba(139, 115, 85, 0.15);
          stroke-width: 1;
        }

        .react-flow__minimap-node {
          stroke: rgba(139, 115, 85, 0.25);
          stroke-width: 1.5;
        }

        /* 背景网格 - 更柔和 */
        .react-flow__background {
          opacity: 0.5;
        }

        /* 边的样式 - 自然流畅 */
        .react-flow__edge path {
          stroke-linecap: round;
          stroke-linejoin: round;
        }

        .react-flow__edge.selected path {
          stroke: #b85845 !important;
          stroke-width: 2.5 !important;
          filter: drop-shadow(0 1px 3px rgba(184, 88, 69, 0.3));
        }

        .react-flow__edge.react-flow__edge-arc path {
          stroke-dasharray: 8,4;
          animation: dash 2s linear infinite;
        }

        @keyframes dash {
          to {
            stroke-dashoffset: -24;
          }
        }

        /* 连接线预览 */
        .react-flow__connectionline {
          stroke: #b85845;
          stroke-width: 2;
          stroke-dasharray: 5,5;
          animation: dash 1s linear infinite;
        }

        /* 选择框 */
        .react-flow__selection {
          background: rgba(184, 88, 69, 0.08);
          border: 1px solid rgba(184, 88, 69, 0.3);
        }

        /* 版权信息 */
        .react-flow__attribution {
          background: linear-gradient(135deg, rgba(255, 255, 255, 0.9) 0%, rgba(250, 248, 245, 0.85) 100%);
          color: rgba(139, 115, 85, 0.65);
          font-size: 10px;
          padding: 3px 8px;
          border-radius: 4px;
          border: 1px solid rgba(139, 115, 85, 0.1);
          box-shadow: 0 1px 2px rgba(139, 115, 85, 0.06);
          backdrop-filter: blur(8px);
        }

        /* 画布整体 */
        .react-flow__pane {
          cursor: grab;
        }

        .react-flow__pane:active {
          cursor: grabbing;
        }
      `}</style>
    </div>
  );
};

export default GraphCanvas;