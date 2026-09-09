import { getSessionGeneration, isCurrentSession } from './authSession';

export interface ListPage<T> {
  items: T[];
  total_count: number;
}

export async function collectPages<T>(
  fetchPage: (limit: number, skip: number) => Promise<ListPage<T>>,
  options: { pageSize: number; keyOf: (item: T) => string | number; signal?: AbortSignal },
): Promise<ListPage<T>> {
  const { pageSize, keyOf, signal } = options;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('Invalid page size');
  const generation = getSessionGeneration();
  const assertCurrent = () => {
    if (signal?.aborted || !isCurrentSession(generation)) throw new DOMException('List request was cancelled', 'AbortError');
  };
  const items: T[] = [];
  const seen = new Set<string | number>();
  let skip = 0;
  while (true) {
    assertCurrent();
    const page = await fetchPage(pageSize, skip);
    assertCurrent();
    if (!Number.isInteger(page.total_count) || page.total_count < 0 || page.items.length > pageSize) {
      throw new Error('Invalid list page');
    }
    const previousSize = seen.size;
    for (const item of page.items) {
      const key = keyOf(item);
      if (!seen.has(key)) { seen.add(key); items.push(item); }
    }
    if (page.items.length > 0 && seen.size === previousSize) throw new Error('List pagination made no progress');
    // 去重不能影响服务端 offset，否则并发更新产生的重叠项会反复取回。
    skip += page.items.length;
    if (page.items.length < pageSize || skip >= page.total_count) return { items, total_count: page.total_count };
  }
}
