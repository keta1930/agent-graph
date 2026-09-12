import type { Element, Root } from 'hast';
import { VFile } from 'vfile';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let plugin: typeof import('./rehypeKatexCached').default;
let katex: typeof import('katex').default;

/** 使用与 remark-math 相同的数学节点，直接检查转换结果和诊断。 */
function renderMath(value: string, display = false) {
  const math: Element = {
    type: 'element', tagName: 'code', properties: { className: [display ? 'math-display' : 'math-inline'] },
    children: [{ type: 'text', value }], position: { start: { line: 1, column: 1 }, end: { line: 1, column: 9 } },
  };
  const tree: Root = { type: 'root', children: [math] };
  const file = new VFile();
  plugin()(tree, file);
  return { tree, file };
}

beforeEach(async () => {
  vi.resetModules();
  katex = (await import('katex')).default;
  plugin = (await import('./rehypeKatexCached')).default;
});

describe('cached official KaTeX transformer', () => {
  it('reuses successful rendering across processor instances and separates display mode', () => {
    const render = vi.spyOn(katex, 'renderToString');
    for (let i = 0; i < 31; i++) renderMath('x^2');
    expect(render).toHaveBeenCalledTimes(1);
    renderMath('x^2', true);
    renderMath('x^2', true);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[0][1]).toMatchObject({ trust: false, maxSize: 20, maxExpand: 1000 });
  });

  it('isolates cached nodes from mutations and strips generated positions', () => {
    const first = renderMath('a+b').tree;
    const original = JSON.stringify(first);
    expect(original).not.toContain('"position"');
    first.children.length = 0;
    const second = renderMath('a+b').tree;
    expect(JSON.stringify(second)).toBe(original);
    (second.children[0] as Element).properties.className = ['changed'];
    expect(JSON.stringify(renderMath('a+b').tree)).toBe(original);
  });

  it('does not cache failures and recovers when TeX changes', () => {
    const render = vi.spyOn(katex, 'renderToString');
    expect(renderMath('\\frac{').file.messages).toHaveLength(1);
    expect(renderMath('\\frac{').file.messages).toHaveLength(1);
    expect(render).toHaveBeenCalledTimes(4);
    expect(renderMath('\\frac{1}{2}').file.messages).toHaveLength(0);
    expect(JSON.stringify(renderMath('\\frac{1}{2}').tree)).not.toContain('katex-error');
    expect(render).toHaveBeenCalledTimes(5);
  });

  it('keeps global macro definitions local to one formula, including cache hits', () => {
    expect(renderMath('\\gdef\\localmacro{z}\\localmacro').file.messages).toHaveLength(0);
    expect(renderMath('\\localmacro').file.messages).toHaveLength(1);
    expect(renderMath('\\gdef\\localmacro{z}\\localmacro').file.messages).toHaveLength(0);
    expect(renderMath('\\localmacro').file.messages).toHaveLength(1);
  });

  it('evicts the least recently used formula at 128 entries', () => {
    const render = vi.spyOn(katex, 'renderToString');
    for (let i = 0; i < 128; i++) renderMath(`x${' '.repeat(i)}`);
    expect(render).toHaveBeenCalledTimes(128);
    renderMath('x');
    expect(render).toHaveBeenCalledTimes(128);
    renderMath('y');
    renderMath('x');
    expect(render).toHaveBeenCalledTimes(129);
    renderMath('x ');
    expect(render).toHaveBeenCalledTimes(130);
  });

  it('evicts by total retained weight even below the entry limit', () => {
    // 用可控输出检查保留预算，避免以巨型 TeX 消耗排版时间。
    const render = vi.spyOn(katex, 'renderToString').mockReturnValue(`<span class="katex">${'x'.repeat(200_000)}</span>`);
    const formula = (letter: string) => letter;
    renderMath(formula('a'));
    renderMath(formula('b'));
    renderMath(formula('c'));
    renderMath(formula('c'));
    expect(render).toHaveBeenCalledTimes(3);
    renderMath(formula('a'));
    expect(render).toHaveBeenCalledTimes(4);
  });

  it('does not retain a single formula above the weight budget', () => {
    const render = vi.spyOn(katex, 'renderToString').mockReturnValue(`<span class="katex">${'x'.repeat(524_288)}</span>`);
    const value = 'oversized';
    renderMath(value);
    renderMath(value);
    expect(render).toHaveBeenCalledTimes(2);
  });
});
