import type { AgentNode, BackendGraphConfig } from '../types/graph';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 在 JSON 边界验证已知字段，保留字符串原值。 */
export function parseGraphConfig(value: unknown): BackendGraphConfig {
  if (
    !object(value) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    !Array.isArray(value.nodes)
  ) {
    throw new Error('Graph must have a name and a nodes array');
  }
  const string = (source: Record<string, unknown>, key: string, fallback = ''): string => {
    if (source[key] === undefined || source[key] === null) return fallback;
    if (typeof source[key] !== 'string') throw new Error(`${key} must be a string`);
    return source[key];
  };
  const strings = (source: Record<string, unknown>, key: string, nullable = false): string[] => {
    const field = source[key];
    if (field === undefined || (nullable && field === null)) return [];
    if (
      !Array.isArray(field) ||
      !field.every((entry): entry is string => typeof entry === 'string')
    )
      throw new Error(`${key} must be a string array`);
    return [...field];
  };
  const number = (source: Record<string, unknown>, key: string): number | undefined => {
    const field = source[key];
    if (field === undefined || field === null) return undefined;
    if (typeof field !== 'number' || !Number.isFinite(field))
      throw new Error(`${key} must be a finite number`);
    return field;
  };
  const boolean = (source: Record<string, unknown>, key: string, fallback: boolean): boolean => {
    if (source[key] === undefined) return fallback;
    if (typeof source[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
    return source[key];
  };
  const names = new Set<string>();
  const nodes: AgentNode[] = value.nodes.map((entry: unknown) => {
    if (!object(entry)) throw new Error('Each node must be an object');
    const name = string(entry, 'name');
    validateNodeName(name, names);
    names.add(name);
    let position;
    if (entry.position !== undefined && entry.position !== null) {
      if (!object(entry.position)) throw new Error('position must contain x and y');
      const x = number(entry.position, 'x');
      const y = number(entry.position, 'y');
      if (x === undefined || y === undefined) throw new Error('position must contain x and y');
      position = { x, y };
    }
    return {
      name,
      description: string(entry, 'description'),
      agent_name: string(entry, 'agent_name') || undefined,
      is_subgraph: boolean(entry, 'is_subgraph', false),
      model_name: string(entry, 'model_name'),
      subgraph_name: string(entry, 'subgraph_name'),
      mcp_servers: strings(entry, 'mcp_servers', true),
      system_tools: strings(entry, 'system_tools', true),
      system_prompt: string(entry, 'system_prompt'),
      user_prompt: string(entry, 'user_prompt'),
      max_iterations: entry.max_iterations === null ? null : number(entry, 'max_iterations'),
      handoffs: number(entry, 'handoffs'),
      level: number(entry, 'level'),
      input_nodes: strings(entry, 'input_nodes'),
      output_nodes: strings(entry, 'output_nodes'),
      output_enabled: boolean(entry, 'output_enabled', true),
      position,
    };
  });
  for (const node of nodes) {
    if (
      node.input_nodes.some((name) => name !== 'start' && !names.has(name)) ||
      node.output_nodes.some((name) => name !== 'end' && !names.has(name))
    ) {
      throw new Error(`Unknown connection on node ${node.name}`);
    }
  }
  return {
    name: value.name,
    description: string(value, 'description'),
    end_template: string(value, 'end_template'),
    nodes,
  };
}

export function validateNodeName(name: string, otherNames: Set<string>): void {
  if (
    !name.trim() ||
    name !== name.trim() ||
    name === 'start' ||
    name === 'end' ||
    /[{}:|/\\.]/.test(name) ||
    otherNames.has(name)
  ) {
    throw new Error(
      'Node name must be unique, nonempty, and cannot use reserved names or template delimiters'
    );
  }
}

/** 与 GraphPromptTemplate 的 | / 首个冒号规则一致，只迁移精确名称 token。 */
export function renameTemplateReferences(
  template: string,
  oldName: string,
  newName: string
): string {
  return template.replace(
    /\{\{([^}]+)\}\}/g,
    (_match, content: string) =>
      `{{${content
        .split('|')
        .map((part) => {
          const colon = part.indexOf(':');
          const namePart = colon < 0 ? part : part.slice(0, colon);
          if (namePart.trim() !== oldName) return part;
          return namePart.replace(oldName, () => newName) + (colon < 0 ? '' : part.slice(colon));
        })
        .join('|')}}}`
  );
}

export function toBackendConfig(graph: BackendGraphConfig): BackendGraphConfig {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const { id, ...config } = node;
      void id;
      return config;
    }),
  };
}
