import { beforeEach, expect, it, vi } from 'vitest';
import { useGraphEditorStore as store } from './graphEditorStore';
import { invalidateSession } from '../utils/authSession';
import * as service from '../services/graphService';
vi.mock('../services/graphService', () => ({ getGraphs: vi.fn(), createGraph: vi.fn(), deleteGraph: vi.fn(), renameGraph: vi.fn(), importGraph: vi.fn(), importGraphFromFile: vi.fn(), importGraphPackage: vi.fn(), importGraphPackageFromFile: vi.fn() }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  invalidateSession();
  const success = { status: 'success', message: '' };
  vi.mocked(service.createGraph).mockResolvedValue(success);
  vi.mocked(service.deleteGraph).mockResolvedValue(success);
  vi.mocked(service.renameGraph).mockResolvedValue(success);
  vi.mocked(service.importGraph).mockResolvedValue(success);
  vi.mocked(service.importGraphFromFile).mockResolvedValue(success);
  vi.mocked(service.importGraphPackage).mockResolvedValue(success);
  vi.mocked(service.importGraphPackageFromFile).mockResolvedValue(success);
});
const operations = [
  ['save', () => { store.getState().createNewGraph('new', ''); return store.getState().saveGraph(); }],
  ['delete', () => store.getState().deleteGraph('old')],
  ['rename', () => store.getState().renameGraph('old', 'new')],
  ['import file path', () => store.getState().importGraph('graph.json')],
  ['import file', () => store.getState().importGraphFromFile(new File(['{}'], 'graph.json'))],
  ['import package path', () => store.getState().importGraphPackage('graph.zip')],
  ['import package', () => store.getState().importGraphPackageFromFile(new File(['zip'], 'graph.zip'))],
] as const;
it.each(operations)('%s refreshes from a new list request instead of reusing a pre-mutation response', async (name, operation) => {
  const old = deferred<string[]>(), fresh = deferred<string[]>();
  vi.mocked(service.getGraphs).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  store.setState({ graphs: ['old'] });
  const previous = store.getState().fetchGraphs();
  const mutation = operation();
  await vi.waitFor(() => expect(service.getGraphs).toHaveBeenCalledTimes(2));
  old.resolve(['old']); await previous;
  const current = store.getState().fetchGraphs();
  expect(service.getGraphs).toHaveBeenCalledTimes(2);
  fresh.resolve(name === 'delete' ? [] : ['new']);
  await Promise.all([mutation, current]);
  expect(store.getState().graphs).toEqual(name === 'delete' ? [] : ['new']);
});
it.each(operations)('%s preserves the new list when the pre-mutation response arrives last', async (name, operation) => {
  const old = deferred<string[]>(), fresh = deferred<string[]>();
  vi.mocked(service.getGraphs).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  store.setState({ graphs: ['old'] });
  const previous = store.getState().fetchGraphs();
  const mutation = operation();
  await vi.waitFor(() => expect(service.getGraphs).toHaveBeenCalledTimes(2));
  const expected = name === 'delete' ? [] : ['new'];
  fresh.resolve(expected); await mutation;
  expect(store.getState().graphs).toEqual(expected);
  old.resolve(['old']); await previous;
  expect(store.getState().graphs).toEqual(expected);
});
it('does not let an obsolete list failure clear the current request or set an error', async () => {
  let fail!: (error: Error) => void;
  const old = new Promise<string[]>((_, reject) => { fail = reject; });
  const fresh = deferred<string[]>();
  vi.mocked(service.getGraphs).mockReturnValueOnce(old).mockReturnValueOnce(fresh.promise);
  const previous = store.getState().fetchGraphs();
  const mutation = store.getState().deleteGraph('old');
  await vi.waitFor(() => expect(service.getGraphs).toHaveBeenCalledTimes(2));
  fail(new Error('obsolete request failed')); await previous;
  const current = store.getState().fetchGraphs();
  expect(service.getGraphs).toHaveBeenCalledTimes(2);
  expect(store.getState().error).toBeUndefined();
  expect(store.getState().loading).toBe(true);
  fresh.resolve([]); await Promise.all([mutation, current]);
  expect(store.getState().loading).toBe(false);
});
it('keeps the newest mutation list even when older post-mutation reads finish later', async () => {
  const first = deferred<string[]>(), second = deferred<string[]>();
  vi.mocked(service.getGraphs).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const initial = store.getState().renameGraph('old', 'new');
  await vi.waitFor(() => expect(service.getGraphs).toHaveBeenCalledOnce());
  const latest = store.getState().deleteGraph('new');
  await vi.waitFor(() => expect(service.getGraphs).toHaveBeenCalledTimes(2));
  second.resolve([]); await latest;
  first.resolve(['new']); await initial;
  expect(store.getState().graphs).toEqual([]);
});
