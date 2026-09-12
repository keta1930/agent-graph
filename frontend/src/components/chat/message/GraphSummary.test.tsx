import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GraphSummary from './GraphSummary';

vi.mock('../../../i18n/hooks', () => ({ useT: () => (key: string) => key }));

describe('GraphSummary Markdown', () => {
  it('renders math and block content in the final result without paragraph nesting', () => {
    const { container } = render(<GraphSummary executionChain={[["node"]]} finalResult={'**Result** $x$\n\n$$\n\\frac{1}{2}\n$$\n\n- Done'} />);
    expect(container.querySelectorAll('.katex')).toHaveLength(2);
    expect(container.querySelector('.markdown-content strong')).toHaveTextContent('Result');
    expect(container.querySelector('li')).toHaveTextContent('Done');
    expect(container.querySelector('p p, p div')).not.toBeInTheDocument();
  });

  it('preserves the execution-chain visibility condition', () => {
    const { container } = render(<GraphSummary finalResult="$x$" />);
    expect(container).toBeEmptyDOMElement();
  });
});
