import { expect, it } from 'vitest';
import { parseGraphConfig, renameTemplateReferences } from './graphEditorModel';
it('renames only exact node tokens in the backend template grammar', () => {
  const source = 'plain a / https://a {{a}} {{ a : 02 | b : all }} {{ab}} {{a:all}} {a}';
  expect(renameTemplateReferences(source, 'a', '$new')).toBe(
    'plain a / https://a {{$new}} {{ $new : 02 | b : all }} {{ab}} {{$new:all}} {a}'
  );
});
it('accepts nullable optional server lists from the backend but rejects malformed topology', () => {
  const graph = { name: 'A', nodes: [{ name: 'a', mcp_servers: null, system_tools: null }] };
  expect(parseGraphConfig(graph).nodes[0]).toMatchObject({ mcp_servers: [], system_tools: [] });
  expect(() =>
    parseGraphConfig({ name: 'A', nodes: [{ name: 'a', input_nodes: ['missing'] }] })
  ).toThrow('Unknown connection');
  expect(() => parseGraphConfig({ name: 'A', nodes: [{ name: 'a' }, { name: 'a' }] })).toThrow();
});

it.each([undefined, null, 1, 3, 50, 200])('preserves the optional graph action limit %s at the read boundary', limit => {
  const graph = { name: 'graph', nodes: [{ name: 'worker', agent_name: 'agent', max_iterations: limit }] };
  expect(parseGraphConfig(graph).nodes[0].max_iterations).toBe(limit);
});
