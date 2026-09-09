import { beforeEach, expect, it, vi } from 'vitest';
import api from './api';
import * as service from './graphService';
vi.mock('./api', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue({ data: {} });
  vi.mocked(api.post).mockResolvedValue({ data: {} });
  vi.mocked(api.put).mockResolvedValue({ data: {} });
  vi.mocked(api.delete).mockResolvedValue({ data: {} });
});
it.each(['a#b', 'a?b', 'a%23b', 'a%b', '图 名称'])('encodes every graph-name route exactly once for %s', async name => {
  await service.getGraph(name); await service.getGraphCard(name); await service.generateMCPScript(name);
  await service.getGraphReadme(name); await service.getGraphVersions(name); await service.createGraphVersion(name, 'message'); await service.deleteGraph(name);
  const encoded = encodeURIComponent(name);
  expect(vi.mocked(api.get).mock.calls.map(([url]) => url)).toEqual([`/graphs/${encoded}`, `/graphs/${encoded}/card`, `/graphs/${encoded}/generate_mcp`, `/graphs/${encoded}/readme`, `/graphs/${encoded}/versions`]);
  expect(api.post).toHaveBeenCalledWith(`/graphs/${encoded}/create-version`, { commit_message: 'message' });
  expect(api.delete).toHaveBeenCalledWith(`/graphs/${encoded}`);
  for (const [path] of vi.mocked(api.get).mock.calls) {
    const url = new URL(path, 'https://fixture.invalid');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(decodeURIComponent(url.pathname.split('/')[2])).toBe(name);
  }
});
it('preserves graph names in JSON bodies', async () => {
  const graph = { name: '图#?%23', description: '', nodes: [] };
  await service.createGraph(graph);
  await service.getPromptTemplate({ graph_name: graph.name });
  expect(api.post).toHaveBeenCalledWith('/graphs', expect.objectContaining({ name: graph.name }));
  expect(api.post).toHaveBeenCalledWith('/prompt-template', { graph_name: graph.name, mcp_servers: [] });
});
it('encodes both rename names and both version route segments without decoding literal percent escapes', async () => {
  await service.renameGraph('old#?', 'new%23');
  await service.getGraphVersion('图#', 'version#?%23');
  await service.deleteGraphVersion('图#', 'version#?%23');
  expect(api.put).toHaveBeenCalledWith('/graphs/old%23%3F/rename/new%2523');
  expect(api.get).toHaveBeenCalledWith('/graphs/%E5%9B%BE%23/versions/version%23%3F%2523');
  expect(api.delete).toHaveBeenCalledWith('/graphs/%E5%9B%BE%23/versions/version%23%3F%2523');
});
it('encodes exported graph paths while preserving the local download filename', async () => {
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:test'); static revokeObjectURL = vi.fn(); });
  const filenames: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    filenames.push(this.download);
  });
  await service.exportGraph('图#?%23');
  expect(api.get).toHaveBeenCalledWith('/graphs/%E5%9B%BE%23%3F%2523/export', { responseType: 'blob' });
  expect(filenames).toEqual(['图#?%23.zip']);
});
