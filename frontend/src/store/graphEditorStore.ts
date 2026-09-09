import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import * as graphService from '../services/graphService';
import type {
  AgentNode,
  BackendGraphConfig,
  NodePosition,
  GraphVersionRecord,
} from '../types/graph';
import { getSessionGeneration, isCurrentSession, registerSessionReset } from '../utils/authSession';
import { getErrorMessage } from '../utils/errors';
import {
  parseGraphConfig,
  renameTemplateReferences,
  toBackendConfig,
  validateNodeName,
} from '../utils/graphEditorModel';

type GraphConfig = BackendGraphConfig;
interface GraphEditorState {
  graphs: string[];
  currentGraph: GraphConfig | null;
  originalGraph: GraphConfig | null;
  loading: boolean;
  saving: boolean;
  error?: string;
  selectedNode: string | null;
  dirty: boolean;
  editorSession: number;
  editRevision: number;
  savedRevision: number;
  jsonDraft: string | null;
  versions: GraphVersionRecord[];
  loadingVersions: boolean;
  fetchGraphs: () => Promise<void>;
  createNewGraph: (name: string, description: string) => void;
  loadGraph: (name: string) => Promise<void>;
  closeGraph: () => void;
  saveGraph: () => Promise<void>;
  deleteGraph: (name: string) => Promise<void>;
  renameGraph: (oldName: string, newName: string) => Promise<void>;
  updateGraphProperties: (updates: Partial<GraphConfig>) => void;
  updateGraphFromJson: (config: BackendGraphConfig) => void;
  beginJsonEditing: () => void;
  setJsonDraft: (text: string) => void;
  applyJsonDraft: () => void;
  endJsonEditing: () => void;
  registerPositionFlusher: (flush: () => void) => () => void;
  addNode: (node: Partial<AgentNode>) => void;
  updateNode: (id: string, updates: Partial<AgentNode>) => void;
  removeNode: (id: string) => void;
  selectNode: (id: string | null) => void;
  updateNodePosition: (id: string, position: NodePosition) => void;
  updateNodePositions: (positions: Record<string, NodePosition>) => void;
  addConnection: (source: string, target: string) => void;
  removeConnection: (source: string, target: string) => void;
  autoLayout: () => void;
  importGraph: typeof graphService.importGraph;
  importGraphFromFile: typeof graphService.importGraphFromFile;
  exportGraph: typeof graphService.exportGraph;
  importGraphPackage: typeof graphService.importGraphPackage;
  importGraphPackageFromFile: typeof graphService.importGraphPackageFromFile;
  getGraphReadme: typeof graphService.getGraphReadme;
  generateMCPScript: (name: string) => Promise<void>;
  fetchVersions: (name: string) => Promise<void>;
  createVersion: (name: string, message: string) => Promise<void>;
  loadVersion: (name: string, versionId: string) => Promise<void>;
  deleteVersion: (name: string, versionId: string) => Promise<void>;
}

const createDefaultNode = (node: Partial<AgentNode>): AgentNode => ({
  name: 'Node ' + Date.now(),
  is_subgraph: false,
  mcp_servers: [],
  system_tools: [],
  system_prompt: '',
  user_prompt: '',
  input_nodes: [],
  output_nodes: [],
  output_enabled: true,
  position: { x: 100, y: 100 },
  ...node,
  id: uuidv4(),
});
const fromBackend = (config: BackendGraphConfig, previous?: GraphConfig | null): GraphConfig => {
  const graph = parseGraphConfig(config);
  const previousIds = new Map(previous?.nodes.map((node) => [node.name, node.id]));
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      id: previousIds.get(node.name) ?? uuidv4(),
      position: node.position ?? { x: 100, y: 100 },
    })),
  };
};

// 自动布局算法 - 横向布局
const calculateAutoLayout = (nodes: AgentNode[]): { [nodeId: string]: NodePosition } => {
  if (nodes.length === 0) return {};

  // 创建节点映射
  const nodeMap = new Map<string, AgentNode>();
  nodes.forEach((node) => {
    nodeMap.set(node.name, node);
  });

  // 计算每个节点的层级
  const calculateNodeLevels = (): Map<string, number> => {
    const levels = new Map<string, number>();
    const visited = new Set<string>();
    const visiting = new Set<string>();

    // 深度优先搜索计算节点层级
    const dfs = (nodeName: string): number => {
      if (visited.has(nodeName)) {
        return levels.get(nodeName) || 0;
      }

      if (visiting.has(nodeName)) {
        // 检测到循环，返回当前已知的最小层级
        return levels.get(nodeName) || 0;
      }

      visiting.add(nodeName);

      const node = nodeMap.get(nodeName);
      if (!node) {
        visited.add(nodeName);
        visiting.delete(nodeName);
        return 0;
      }

      // 如果节点已经有层级设置，使用现有层级作为基础
      if (node.level !== undefined && node.level !== null) {
        levels.set(nodeName, node.level);
        visited.add(nodeName);
        visiting.delete(nodeName);
        return node.level;
      }

      let maxInputLevel = -1;

      // 遍历输入节点
      for (const inputNodeName of node.input_nodes || []) {
        if (inputNodeName === 'start') {
          maxInputLevel = Math.max(maxInputLevel, -1); // start 节点层级为 -1
        } else {
          const inputLevel = dfs(inputNodeName);
          maxInputLevel = Math.max(maxInputLevel, inputLevel);
        }
      }

      const currentLevel = maxInputLevel + 1;
      levels.set(nodeName, currentLevel);

      visiting.delete(nodeName);
      visited.add(nodeName);

      return currentLevel;
    };

    // 计算所有节点的层级
    nodes.forEach((node) => {
      dfs(node.name);
    });

    return levels;
  };

  const nodeLevels = calculateNodeLevels();

  // 按层级分组节点
  const levelGroups = new Map<number, AgentNode[]>();
  nodes.forEach((node) => {
    const level = nodeLevels.get(node.name) || 0;
    if (!levelGroups.has(level)) {
      levelGroups.set(level, []);
    }
    levelGroups.get(level)!.push(node);
  });

  // 布局常量 - 横向布局
  const LEVEL_WIDTH = 300; // 层级间水平间距
  const NODE_HEIGHT = 200; // 节点间垂直间距
  const START_X = 100; // 起始X坐标
  const START_Y = 100; // 起始Y坐标

  // 生成位置
  const positions: { [nodeId: string]: NodePosition } = {};

  // 获取所有层级并排序
  const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b);

  sortedLevels.forEach((level, levelIndex) => {
    const nodesInLevel = levelGroups.get(level)!;
    const x = START_X + levelIndex * LEVEL_WIDTH; // 横向排列：X坐标根据层级递增

    // 垂直居中排列
    const totalHeight = (nodesInLevel.length - 1) * NODE_HEIGHT;
    const startY = START_Y + Math.max(0, (600 - totalHeight) / 2); // 假设画布高度为600px

    nodesInLevel.forEach((node, nodeIndex) => {
      const y = startY + nodeIndex * NODE_HEIGHT;
      positions[node.id!] = { x, y };
    });
  });

  return positions;
};

let loadGeneration = 0;
let listGeneration = 0;
let versionGeneration = 0;
let operationGeneration = 0;
let positionFlusher: (() => void) | undefined;
let listRequest: Promise<void> | undefined;
let saveRequest: { session: number; promise: Promise<void> } | undefined;

const initialState = () => ({
  graphs: [],
  currentGraph: null,
  originalGraph: null,
  loading: false,
  saving: false,
  selectedNode: null,
  dirty: false,
  error: undefined,
  editRevision: 0,
  savedRevision: 0,
  jsonDraft: null,
  versions: [],
  loadingVersions: false,
});

export const useGraphEditorStore = create<GraphEditorState>((set, get) => {
  const changed = (graph: GraphConfig) =>
    set((state) => ({
      currentGraph: graph,
      editRevision: state.editRevision + 1,
      dirty: true,
      selectedNode: graph.nodes.some((node) => node.id === state.selectedNode)
        ? state.selectedNode
        : null,
    }));
  const active = (epoch: number, session: number) =>
    isCurrentSession(epoch) && get().editorSession === session;
  const assertActive = (epoch: number, session: number) => {
    if (!active(epoch, session))
      throw new DOMException('Graph editor session changed', 'AbortError');
  };
  const replaceEditor = (graph: GraphConfig | null, original = graph, dirty = false) => {
    loadGeneration++;
    versionGeneration++;
    operationGeneration++;
    positionFlusher = undefined;
    saveRequest = undefined;
    set((state) => ({
      currentGraph: graph,
      originalGraph: original,
      selectedNode: null,
      dirty,
      editRevision: dirty ? 1 : 0,
      savedRevision: 0,
      editorSession: state.editorSession + 1,
      jsonDraft: null,
      versions: [],
      loadingVersions: false,
      saving: false,
      loading: false,
      error: undefined,
    }));
  };
  const refreshGraphList = () => {
    // mutation 之前发出的列表即使尚未返回，也不能用于确认这次写入。
    listGeneration++;
    listRequest = undefined;
    return get().fetchGraphs();
  };
  // 非编辑器请求仍校验账户；只有最新操作可以结束自己的 loading。
  const operation = async <T>(request: () => Promise<T>, refresh = false): Promise<T> => {
    const epoch = getSessionGeneration();
    const token = ++operationGeneration;
    set({ loading: true, error: undefined });
    try {
      const result = await request();
      if (!isCurrentSession(epoch)) throw new DOMException('Session changed', 'AbortError');
      if (refresh) await refreshGraphList();
      if (!isCurrentSession(epoch)) throw new DOMException('Session changed', 'AbortError');
      return result;
    } catch (error) {
      if (isCurrentSession(epoch) && token === operationGeneration)
        set({ error: getErrorMessage(error) });
      throw error;
    } finally {
      if (isCurrentSession(epoch) && token === operationGeneration) set({ loading: false });
    }
  };
  const connection = (sourceId: string, targetId: string, remove: boolean) => {
    const graph = get().currentGraph;
    const source = graph?.nodes.find((node) => node.id === sourceId);
    const target = graph?.nodes.find((node) => node.id === targetId);
    if (!graph || !source || !target) return;
    const updateNames = (names: string[], name: string) =>
      remove
        ? names.filter((item) => item !== name)
        : names.includes(name)
          ? names
          : [...names, name];
    const nodes = graph.nodes.map((node) => {
      const input_nodes =
        node.id === targetId ? updateNames(node.input_nodes, source.name) : node.input_nodes;
      const output_nodes =
        node.id === sourceId ? updateNames(node.output_nodes, target.name) : node.output_nodes;
      return input_nodes === node.input_nodes && output_nodes === node.output_nodes
        ? node
        : { ...node, input_nodes, output_nodes };
    });
    changed({ ...graph, nodes });
  };
  return {
    ...initialState(),
    editorSession: 0,
    fetchGraphs: () => {
      if (listRequest) return listRequest;
      const epoch = getSessionGeneration();
      const token = ++listGeneration;
      const request = (async () => {
        try {
          const graphs = await graphService.getGraphs();
          if (isCurrentSession(epoch) && token === listGeneration) set({ graphs });
        } catch (error) {
          if (isCurrentSession(epoch) && token === listGeneration)
            set({ error: getErrorMessage(error) });
        } finally {
          if (isCurrentSession(epoch) && token === listGeneration) listRequest = undefined;
        }
      })();
      listRequest = request;
      return request;
    },
    createNewGraph: (name, description) =>
      replaceEditor({ name, description, nodes: [], end_template: '' }, null, true),
    closeGraph: () => replaceEditor(null),
    loadGraph: async (name) => {
      const epoch = getSessionGeneration();
      const token = ++loadGeneration;
      set({ loading: true, error: undefined });
      try {
        const graph = fromBackend(await graphService.getGraph(name));
        if (!isCurrentSession(epoch) || token !== loadGeneration)
          throw new DOMException('Graph load superseded', 'AbortError');
        replaceEditor(graph);
      } catch (error) {
        if (isCurrentSession(epoch) && token === loadGeneration)
          set({ loading: false, error: getErrorMessage(error) });
        throw error;
      }
    },
    saveGraph: () => {
      const session = get().editorSession;
      if (saveRequest?.session === session) return saveRequest.promise;
      try {
        positionFlusher?.();
        get().applyJsonDraft();
      } catch (error) {
        set({ error: getErrorMessage(error) });
        return Promise.reject(error);
      }
      const { currentGraph, editRevision } = get();
      if (!currentGraph) return Promise.resolve();
      const epoch = getSessionGeneration();
      const snapshot = structuredClone(currentGraph);
      set({ saving: true, error: undefined });
      const promise = (async () => {
        try {
          await graphService.createGraph(toBackendConfig(snapshot));
          if (!isCurrentSession(epoch)) throw new DOMException('Session changed', 'AbortError');
          const refresh = refreshGraphList();
          assertActive(epoch, session);
          set((state) => ({
            originalGraph: snapshot,
            savedRevision: editRevision,
            dirty: state.editRevision !== editRevision,
          }));
          await refresh;
          assertActive(epoch, session);
        } catch (error) {
          if (active(epoch, session)) set({ error: getErrorMessage(error) });
          throw error;
        } finally {
          if (active(epoch, session)) set({ saving: false });
          if (active(epoch, session)) saveRequest = undefined;
        }
      })();
      saveRequest = { session, promise };
      return promise;
    },
    deleteGraph: (name) =>
      operation(async () => {
        const epoch = getSessionGeneration();
        const session = get().editorSession;
        await graphService.deleteGraph(name);
        if (active(epoch, session) && get().currentGraph?.name === name) replaceEditor(null);
        if (isCurrentSession(epoch))
          set((state) => ({ graphs: state.graphs.filter((graph) => graph !== name) }));
      }, true),
    renameGraph: (oldName, newName) =>
      operation(async () => {
        const epoch = getSessionGeneration();
        const session = get().editorSession;
        await graphService.renameGraph(oldName, newName);
        if (active(epoch, session) && get().currentGraph?.name === oldName) {
          set((state) => ({
            currentGraph: state.currentGraph && { ...state.currentGraph, name: newName },
            originalGraph: state.originalGraph && { ...state.originalGraph, name: newName },
          }));
        }
      }, true),
    updateGraphProperties: (updates) => {
      get().applyJsonDraft();
      const graph = get().currentGraph;
      if (graph) {
        const next = { ...graph, ...updates };
        changed(next);
        if (get().jsonDraft !== null)
          set({ jsonDraft: JSON.stringify(toBackendConfig(next), null, 2) });
      }
    },
    updateGraphFromJson: (config) => {
      const graph = get().currentGraph;
      if (graph) changed(fromBackend({ ...config, name: graph.name }, graph));
    },
    beginJsonEditing: () => {
      positionFlusher?.();
      const graph = get().currentGraph;
      if (graph && get().jsonDraft === null)
        set({ jsonDraft: JSON.stringify(toBackendConfig(graph), null, 2) });
    },
    setJsonDraft: (text) => {
      if (text !== get().jsonDraft)
        set((state) => ({ jsonDraft: text, editRevision: state.editRevision + 1, dirty: true }));
    },
    applyJsonDraft: () => {
      const { currentGraph, jsonDraft } = get();
      if (!currentGraph || jsonDraft === null) return;
      const config = parseGraphConfig(JSON.parse(jsonDraft));
      const graph = fromBackend({ ...config, name: currentGraph.name }, currentGraph);
      if (JSON.stringify(toBackendConfig(graph)) !== JSON.stringify(toBackendConfig(currentGraph)))
        set((state) => ({
          currentGraph: graph,
          selectedNode: graph.nodes.some((node) => node.id === state.selectedNode)
            ? state.selectedNode
            : null,
        }));
    },
    endJsonEditing: () => {
      get().applyJsonDraft();
      set({ jsonDraft: null });
    },
    registerPositionFlusher: (flush) => {
      positionFlusher = flush;
      return () => {
        if (positionFlusher === flush) positionFlusher = undefined;
      };
    },
    addNode: (data) => {
      const graph = get().currentGraph;
      if (!graph) return;
      const node = createDefaultNode(data);
      validateNodeName(node.name, new Set(graph.nodes.map((item) => item.name)));
      changed({ ...graph, nodes: [...graph.nodes, node] });
    },
    updateNode: (id, updates) => {
      const graph = get().currentGraph;
      const node = graph?.nodes.find((item) => item.id === id);
      if (!graph || !node) return;
      const newName = updates.name ?? node.name;
      validateNodeName(
        newName,
        new Set(graph.nodes.filter((item) => item.id !== id).map((item) => item.name))
      );
      const rename = (text: string) => renameTemplateReferences(text, node.name, newName);
      const renameNames = (names: string[]) =>
        names.includes(node.name)
          ? names.map((name) => (name === node.name ? newName : name))
          : names;
      let nodes = graph.nodes.map((item) => {
        const updated = item.id === id ? { ...item, ...updates } : item;
        if (newName === node.name) return updated;
        const input_nodes = renameNames(updated.input_nodes);
        const output_nodes = renameNames(updated.output_nodes);
        const system_prompt = rename(updated.system_prompt);
        const user_prompt = rename(updated.user_prompt);
        if (
          input_nodes === updated.input_nodes &&
          output_nodes === updated.output_nodes &&
          system_prompt === updated.system_prompt &&
          user_prompt === updated.user_prompt
        )
          return updated;
        return { ...updated, input_nodes, output_nodes, system_prompt, user_prompt };
      });
      const edited = nodes.find((item) => item.id === id)!;
      if (updates.input_nodes || updates.output_nodes) {
        nodes = nodes.map((item) => {
          if (item.id === id) return item;
          let input_nodes = item.input_nodes;
          let output_nodes = item.output_nodes;
          if (updates.output_nodes)
            input_nodes = edited.output_nodes.includes(item.name)
              ? [...new Set([...input_nodes, newName])]
              : input_nodes.filter((name) => name !== newName);
          if (updates.input_nodes)
            output_nodes = edited.input_nodes.includes(item.name)
              ? [...new Set([...output_nodes, newName])]
              : output_nodes.filter((name) => name !== newName);
          return input_nodes === item.input_nodes && output_nodes === item.output_nodes
            ? item
            : { ...item, input_nodes, output_nodes };
        });
      }
      changed({
        ...graph,
        nodes,
        end_template: newName === node.name ? graph.end_template : rename(graph.end_template ?? ''),
      });
    },
    removeNode: (id) => {
      const graph = get().currentGraph;
      const removed = graph?.nodes.find((node) => node.id === id);
      if (!graph || !removed) return;
      const nodes = graph.nodes
        .filter((node) => node.id !== id)
        .map((node) => {
          if (!node.input_nodes.includes(removed.name) && !node.output_nodes.includes(removed.name))
            return node;
          return {
            ...node,
            input_nodes: node.input_nodes.filter((name) => name !== removed.name),
            output_nodes: node.output_nodes.filter((name) => name !== removed.name),
          };
        });
      changed({ ...graph, nodes });
    },
    selectNode: (id) => set({ selectedNode: id }),
    updateNodePosition: (id, position) => get().updateNodePositions({ [id]: position }),
    updateNodePositions: (positions) => {
      const graph = get().currentGraph;
      if (!graph) return;
      let modified = false;
      const nodes = graph.nodes.map((node) => {
        const position = positions[node.id!];
        if (!position || (position.x === node.position?.x && position.y === node.position?.y))
          return node;
        modified = true;
        return { ...node, position: { ...position } };
      });
      if (modified) changed({ ...graph, nodes });
    },
    autoLayout: () => {
      const graph = get().currentGraph;
      if (graph) get().updateNodePositions(calculateAutoLayout(graph.nodes));
    },
    addConnection: (source, target) => connection(source, target, false),
    removeConnection: (source, target) => connection(source, target, true),
    importGraph: (path) => operation(() => graphService.importGraph(path), true),
    importGraphFromFile: (file) => operation(() => graphService.importGraphFromFile(file), true),
    importGraphPackage: (path) => operation(() => graphService.importGraphPackage(path), true),
    importGraphPackageFromFile: (file) =>
      operation(() => graphService.importGraphPackageFromFile(file), true),
    exportGraph: (name) => operation(() => graphService.exportGraph(name)),
    getGraphReadme: (name) =>
      operation(async () => {
        const epoch = getSessionGeneration();
        const session = get().editorSession;
        const result = await graphService.getGraphReadme(name);
        assertActive(epoch, session);
        return result;
      }),
    generateMCPScript: (name) =>
      operation(async () => {
        if (get().currentGraph?.name === name) await get().saveGraph();
        await graphService.downloadMCPScript(name);
      }),
    fetchVersions: async (name) => {
      const epoch = getSessionGeneration();
      const session = get().editorSession;
      const token = ++versionGeneration;
      set({ loadingVersions: true });
      try {
        const result = await graphService.getGraphVersions(name);
        if (active(epoch, session) && token === versionGeneration)
          set({ versions: result.versions });
      } catch (error) {
        if (active(epoch, session) && token === versionGeneration)
          set({ error: getErrorMessage(error) });
        throw error;
      } finally {
        if (active(epoch, session) && token === versionGeneration) set({ loadingVersions: false });
      }
    },
    createVersion: (name, message) =>
      operation(async () => {
        const epoch = getSessionGeneration();
        const session = get().editorSession;
        if (get().currentGraph?.name === name) await get().saveGraph();
        assertActive(epoch, session);
        await graphService.createGraphVersion(name, message);
        assertActive(epoch, session);
        await get()
          .fetchVersions(name)
          .catch(() => {});
        assertActive(epoch, session);
      }),
    loadVersion: async (name, versionId) => {
      const epoch = getSessionGeneration();
      const token = ++loadGeneration;
      set({ loading: true, error: undefined });
      try {
        const [version, latest] = await Promise.all([
          graphService.getGraphVersion(name, versionId),
          graphService.getGraph(name),
        ]);
        if (!isCurrentSession(epoch) || token !== loadGeneration)
          throw new DOMException('Version load superseded', 'AbortError');
        replaceEditor(fromBackend(version.config), fromBackend(latest), true);
      } catch (error) {
        if (isCurrentSession(epoch) && token === loadGeneration)
          set({ loading: false, error: getErrorMessage(error) });
        throw error;
      }
    },
    deleteVersion: (name, versionId) =>
      operation(async () => {
        const epoch = getSessionGeneration();
        const session = get().editorSession;
        await graphService.deleteGraphVersion(name, versionId);
        assertActive(epoch, session);
        await get()
          .fetchVersions(name)
          .catch(() => {});
        assertActive(epoch, session);
      }),
  };
});

registerSessionReset(() => {
  loadGeneration++;
  listGeneration++;
  versionGeneration++;
  operationGeneration++;
  positionFlusher = undefined;
  listRequest = undefined;
  saveRequest = undefined;
  useGraphEditorStore.setState((state) => ({
    ...initialState(),
    editorSession: state.editorSession + 1,
  }));
});
