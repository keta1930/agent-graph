import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownContent from './MarkdownContent';
import bellmanResponse from '../../test/fixtures/bellman-response.md?raw';

describe('model LaTeX delimiters', () => {
  it('renders the exact stored Bellman response without losing superscript stars', () => {
    const { container } = render(<MarkdownContent>{bellmanResponse}</MarkdownContent>);
    expect(container.querySelectorAll('.katex')).toHaveLength(25);
    expect(container.querySelectorAll('.katex-display')).toHaveLength(4);
    expect(container.querySelectorAll('math')).toHaveLength(25);
    expect(container.querySelector('.katex-error, .katex em')).not.toBeInTheDocument();
    const values = [...container.querySelectorAll('annotation')].map(node => node.textContent).join('\n');
    expect(values.match(/V\^\*/g)).toHaveLength(3);
    expect(values.match(/Q\^\*/g)).toHaveLength(2);
    expect(container.querySelectorAll('li')).toHaveLength(8);
    expect(container.querySelector('strong')).toHaveTextContent('最优贝尔曼方程');
  });

  it.each([
    String.raw`\[x^2\]`,
    '\\[\nx^2\n\\]',
    '公式：\n\\[\nx^2\n\\]  \n后文',
    '\\[\nx^2\n\n+y\n\\]',
  ])('renders a standalone display block: %s', (source) => {
    const { container } = render(<MarkdownContent>{source}</MarkdownContent>);
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(container.querySelector('.katex-error, p .katex-display')).not.toBeInTheDocument();
  });

  it('supports inline math in Markdown formatting, links, and GFM tables', () => {
    const source = '**中文 \\(V^*(s)+Q_a\\)** [\\(x\\)](https://example.com)\n\n| formula |\n| --- |\n| \\(y\\) |\n\n- [x] ~~done~~ $z$';
    const { container } = render(<MarkdownContent>{source}</MarkdownContent>);
    expect(container.querySelectorAll('.katex')).toHaveLength(4);
    expect(container.querySelector('strong annotation')).toHaveTextContent('V^*(s)+Q_a');
    expect(container.querySelector('a .katex')).toBeInTheDocument();
    expect(container.querySelector('td .katex')).toBeInTheDocument();
    expect(container.querySelector('input[type="checkbox"]')).toBeChecked();
    expect(container.querySelector('del')).toHaveTextContent('done');
  });

  it.each([
    String.raw`前 \[x\] 后`,
    String.raw`\[x\] 后`,
    String.raw`\\(x\\) \\[x\\]`,
    String.raw`(x) [x] \*literal\* Costs \$5 and \$10`,
    '\\(x\n\n+y\\)',
    '> \\[\nx\n\\]',
  ])('keeps ordinary or unsupported block boundaries as Markdown: %s', (source) => {
    const { container } = render(<MarkdownContent>{source}</MarkdownContent>);
    expect(container.querySelector('.katex')).not.toBeInTheDocument();
  });

  it('preserves delimiters in code, link URLs, and image alt text', () => {
    const source = '`\\(x\\)`\n\n```text\n\\[y\\]\n```\n\n~~~js\n"\\(z\\)"\n~~~\n\n    \\[w\\]\n\n[link](https://example.com/a\\(b\\)) ![\\(alt\\)](/image.png) ![ordinary text](/plain.png)';
    const { container } = render(<MarkdownContent>{source}</MarkdownContent>);
    expect(container.querySelector('.katex')).not.toBeInTheDocument();
    expect(container.querySelector('p code')).toHaveTextContent(String.raw`\(x\)`);
    expect(container.querySelectorAll('pre code')).toHaveLength(3);
    expect(container.querySelector('a')).toHaveAttribute('href', 'https://example.com/a(b)');
    // 图片说明沿用美元数学语义：只保留 TeX 文字，不生成公式 DOM。
    expect(container.querySelector('img')).toHaveAttribute('alt', 'alt');
    expect(container.querySelector('img')).toHaveAttribute('src', '/image.png');
    expect(container.querySelectorAll('img')[1]).toHaveAttribute('alt', 'ordinary text');
    expect(container.querySelectorAll('img')[1]).toHaveAttribute('src', '/plain.png');
  });

  it('preserves TeX row breaks and spacing before brackets', () => {
    const source = String.raw`\[\begin{aligned}a &= b \\[2pt] c &= d\end{aligned}\]`;
    const { container } = render(<MarkdownContent>{source}</MarkdownContent>);
    expect(container.querySelector('.katex-display')).toBeInTheDocument();
    expect(container.querySelector('.katex-error')).not.toBeInTheDocument();
    expect(container.querySelector('annotation')).toHaveTextContent(String.raw`\begin{aligned}a &= b \\[2pt] c &= d\end{aligned}`);
  });

  it('recovers from incomplete delimiters and invalid TeX', () => {
    const { container, rerender } = render(<MarkdownContent>{'\\'}</MarkdownContent>);
    for (const source of ['\\(', '\\(\\frac', '\\(\\frac{1}{\\)']) {
      rerender(<MarkdownContent>{source}</MarkdownContent>);
    }
    expect(container.querySelector('.katex-error')).toHaveTextContent('\\frac{1}{');
    rerender(<MarkdownContent>{String.raw`\(\frac{1}{2}\)`}</MarkdownContent>);
    expect(container.querySelector('.katex-error')).not.toBeInTheDocument();
    expect(container.querySelector('.katex')).toBeInTheDocument();
  });

  it.each([
    String.raw`\(\href{https://example.com}{link}\)`,
    String.raw`\(\includegraphics{https://example.com/image.png}\)`,
    String.raw`\(\htmlClass{unsafe}{x}\)`,
    String.raw`\(\def\loop{\loop}\loop\)`,
  ])('retains the existing math safety boundary: %s', (source) => {
    const { container } = render(<MarkdownContent>{source}</MarkdownContent>);
    expect(container.querySelector('a, img, script, .unsafe')).not.toBeInTheDocument();
    expect(container.textContent).not.toBe('');
  });
});
