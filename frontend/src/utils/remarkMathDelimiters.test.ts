import type { Root } from 'mdast';
import type { Construct } from 'micromark-util-types';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import { visitParents } from 'unist-util-visit-parents';
import { describe, expect, it } from 'vitest';
import remarkMathDelimiters from './remarkMathDelimiters';

/** 检查 parser 产生的真实数学值与源码范围，不依赖 KaTeX 容错。 */
function parse(source: string) {
  return unified().use(remarkParse).use(remarkMath).use(remarkMathDelimiters).parse(source);
}
function mathValues(tree: Root) {
  const values: string[] = [];
  visitParents(tree, node => {
    if (node.type === 'inlineMath' || node.type === 'math') values.push(node.value);
  });
  return values;
}

describe('LaTeX delimiter tokenizer boundaries', () => {
  it.each([
    [String.raw`\(a \\) b\)`, String.raw`a \\) b`],
    [String.raw`\[a \\] b\]`, String.raw`a \\] b`],
    [String.raw`\(a \\\)`, String.raw`a \\`],
    [String.raw`\[a \\\]`, String.raw`a \\`],
    [String.raw`\\\(x\)`, 'x'],
    [String.raw`\[a\] more + b\]`, String.raw`a\] more + b`],
  ])('treats backslash pairs atomically in %s', (source, expected) => {
    expect(mathValues(parse(source))).toEqual([expected]);
  });

  it.each([0, 1, 2, 3])('accepts %i-space display indentation', (indent) => {
    expect(mathValues(parse(`${' '.repeat(indent)}\\[\n${' '.repeat(indent)}x\n${' '.repeat(indent)}\\]`))).toEqual(['x']);
  });

  it('keeps four-space indented content as code', () => {
    const tree = parse('    \\[x\\]');
    expect(tree.children[0].type).toBe('code');
    expect(mathValues(tree)).toEqual([]);
  });

  it.each([
    ['> \\[\n> x\n> \\]', 'blockquote'],
    ['- \\[\n  x\n  \\]', 'list'],
    ['> \\(x\\)', 'blockquote'],
    ['- \\(x\\)', 'list'],
  ])('preserves the surrounding container: %s', (source, container) => {
    const tree = parse(source);
    expect(tree.children[0].type).toBe(container);
    expect(mathValues(tree)).toEqual(['x']);
  });

  it.each(['\\', '\\(', '\\[', '\\(x', '\\[\nx', '> \\[\nx\n\\]'])('falls back for an incomplete formula: %s', (source) => {
    expect(mathValues(parse(source))).toEqual([]);
  });

  it.each([
    '\\(broken \\(x\\)',
    '\\[\nbroken\n\\[x\\]',
  ])('resumes at a new opener after an incomplete candidate: %s', (source) => {
    expect(mathValues(parse(source))).toEqual(['x']);
  });

  it.each(['\n', '\r\n'])('retains exact offsets around Unicode and containers (%j)', (eol) => {
    const source = ['中文😀 \\(x^*\\)', '', '> \\[y\\]', '', '> ```javascript', '> const n = 1;', '> ```'].join(eol);
    const tree = parse(source);
    const slices: string[] = [];
    visitParents(tree, node => {
      if (node.type === 'inlineMath' || node.type === 'math' || node.type === 'code') {
        slices.push(source.slice(node.position?.start.offset, node.position?.end.offset));
      }
    });
    expect(slices).toEqual(['\\(x^*\\)', '\\[y\\]', ['```javascript', '> const n = 1;', '> ```'].join(eol)]);
  });

  it('keeps text readable when an unclosed display opener interrupts a paragraph', () => {
    const tree = parse('before\n\\[unclosed\nafter');
    expect(mathValues(tree)).toEqual([]);
    expect(tree.children).toHaveLength(2);
    expect(tree.children.every(node => node.type === 'paragraph')).toBe(true);
    const texts: string[] = [];
    visitParents(tree, 'text', node => { texts.push(node.value); });
    expect(texts.join('\n')).toBe('before\n[unclosed\nafter');
  });

  it('keeps a later code fence after an unclosed math candidate', () => {
    const source = '\\[\nx\n\n```javascript\nconst later = 1;\n```';
    const tree = parse(source);
    expect(mathValues(tree)).toEqual([]);
    expect(tree.children.some(node => node.type === 'code' && node.value === 'const later = 1;')).toBe(true);
  });

  it.each([false, true])('does not rescan the remaining input at every unmatched opener (display=%s)', (display) => {
    /** 计数公开 tokenizer 的字符消费，避免依赖机器速度的毫秒断言。 */
    function consumed(count: number) {
      const processor = unified().use(remarkParse).use(remarkMath).use(remarkMathDelimiters).freeze();
      const extension = processor.data().micromarkExtensions!.slice(-1)[0];
      const construct = (display ? extension.flow![92] : extension.text![92]) as Construct;
      const tokenize = construct.tokenize;
      let consumption = 0;
      construct.tokenize = function (effects, ok, nok) {
        return tokenize.call(this, { ...effects, consume(code) { consumption++; effects.consume(code); } }, ok, nok);
      };
      const source = display ? '\\[\nx\n'.repeat(count) : '\\(x '.repeat(count);
      processor.parse(source);
      return consumption;
    }
    const small = consumed(100);
    const large = consumed(200);
    expect(small).toBeGreaterThan(100);
    expect(large).toBeLessThan(small * 2.2);
  });
});
