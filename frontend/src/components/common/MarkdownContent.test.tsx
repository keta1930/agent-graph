import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownContent from './MarkdownContent';

describe('MarkdownContent', () => {
  it('renders inline, display, fenced math and GFM with accessible MathML', () => {
    const { container } = render(<MarkdownContent>{'中文 $x^2$，$$y$$\n\n$$\n\\frac{1}{2}+\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\n$$\n\n```math\nx+1\n```\n\n| Value |\n| --- |\n| $2x$ |'}</MarkdownContent>);
    expect(container.querySelectorAll('.katex')).toHaveLength(5);
    expect(container.querySelectorAll('.katex-display')).toHaveLength(2);
    expect(container.querySelectorAll('math')).toHaveLength(5);
    expect(container.querySelector('td .katex')).toBeInTheDocument();
    expect(container.querySelector('pre')).not.toBeInTheDocument();
  });

  it('preserves code, escaped currency and the native dollar boundaries', () => {
    const { container, rerender } = render(<MarkdownContent>{'`$x$`\n\n```js\nconst value = "$y$";\n```\n\nCosts \\$5 and \\$10.'}</MarkdownContent>);
    expect(container.querySelector('.katex')).not.toBeInTheDocument();
    expect(container.querySelector('p code')).toHaveTextContent('$x$');
    expect(container.querySelector('pre code')).toHaveTextContent('const value = "$y$";');
    expect(container).toHaveTextContent('Costs $5 and $10.');
    rerender(<MarkdownContent>{'Costs $5 and $10'}</MarkdownContent>);
    expect(container.querySelectorAll('.katex')).toHaveLength(1);
  });

  it('keeps errors readable and recovers on completed input', () => {
    const { container, rerender } = render(<MarkdownContent>{'$\\frac{1}{$'}</MarkdownContent>);
    expect(container.querySelector('.katex-error')).toHaveTextContent('\\frac{1}{');
    rerender(<MarkdownContent>{'$\\frac{1}{2}$'}</MarkdownContent>);
    expect(container.querySelector('.katex-error')).not.toBeInTheDocument();
    expect(container.querySelector('.katex')).toBeInTheDocument();
  });

  it.each([
    String.raw`$\href{https://example.com}{link}$`,
    String.raw`$\includegraphics{https://example.com/image.png}$`,
    String.raw`$\htmlClass{unsafe}{x}$`,
    '<img src="https://example.com/image.png" onerror="alert(1)">',
    String.raw`$\def\loop{\loop}\loop$`,
    String.raw`$\unknowncommand{x}$`,
  ])('does not enable untrusted resources or HTML: %s', (source) => {
    const { container } = render(<MarkdownContent>{source}</MarkdownContent>);
    expect(container.querySelector('a, img, script, .unsafe, [onerror]')).not.toBeInTheDocument();
    expect(container.textContent).not.toBe('');
  });
});
