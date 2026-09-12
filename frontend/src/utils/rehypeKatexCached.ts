import type { ElementContent, Root } from 'hast';
import { toText } from 'hast-util-to-text';
import rehypeKatex from 'rehype-katex';
import { SKIP, visitParents } from 'unist-util-visit-parents';

const MAX_ENTRIES = 128;
const MAX_WEIGHT = 524_288;
const cache = new Map<string, string>();
let cacheWeight = 0;
const renderMath = rehypeKatex({ trust: false, maxSize: 20, maxExpand: 1000, strict: 'ignore' });

/** 仅保留生成节点，序列化同时隔离消费者引用与源位置信息。 */
function remember(key: string, children: ElementContent[]) {
  const serialized = JSON.stringify(children, (name, value) => name === 'position' ? undefined : value);
  const weight = key.length + serialized.length;
  if (weight > MAX_WEIGHT) return;
  while (cache.size >= MAX_ENTRIES || cacheWeight + weight > MAX_WEIGHT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheWeight -= oldest.length + cache.get(oldest)!.length;
    cache.delete(oldest);
  }
  cache.set(key, serialized);
  cacheWeight += weight;
}

/** 复用官方数学转换器，并跨 Markdown 更新缓存成功的公式排版。 */
export default function rehypeKatexCached(): ReturnType<typeof rehypeKatex> {
  return (tree, file) => {
    visitParents(tree, 'element', (element, parents) => {
      const classes = Array.isArray(element.properties.className) ? element.properties.className : [];
      const languageMath = classes.includes('language-math');
      let displayMode = classes.includes('math-display');
      if (!languageMath && !displayMode && !classes.includes('math-inline')) return;

      let scope = element;
      let parent = parents[parents.length - 1];
      if (element.tagName === 'code' && languageMath && parent?.type === 'element' && parent.tagName === 'pre') {
        scope = parent;
        parent = parents[parents.length - 2];
        displayMode = true;
      }
      if (!parent) return;

      const key = JSON.stringify([displayMode, toText(scope, { whitespace: 'pre' })]);
      const cached = cache.get(key);
      let result: ElementContent[];
      if (cached !== undefined) {
        cache.delete(key);
        cache.set(key, cached);
        result = JSON.parse(cached) as ElementContent[];
      } else {
        const root: Root = { type: 'root', children: [scope] };
        const messageCount = file.messages.length;
        renderMath(root, file);
        result = root.children as ElementContent[];
        let hasError = false;
        visitParents(root, (node) => {
          delete node.position;
          if (node.type === 'element' && Array.isArray(node.properties.className) && node.properties.className.includes('katex-error')) {
            hasError = true;
          }
        });
        if (!hasError && file.messages.length === messageCount) remember(key, result);
      }
      parent.children.splice(parent.children.indexOf(scope), 1, ...result);
      return SKIP;
    });
  };
}
