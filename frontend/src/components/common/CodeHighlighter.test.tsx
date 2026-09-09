import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CodeHighlighter from './CodeHighlighter';

describe('CodeHighlighter', () => {
  it.each(['typescript', 'c++', 'unknown-language', undefined])('preserves code for %s', async (language) => {
    const code = 'const value = "https://example.com";\n// 中文\n';
    const { container } = render(<CodeHighlighter code={code} language={language} className="sample" />);
    expect(container.querySelector('pre code')?.textContent).toBe(code);
    await waitFor(() => expect(container.querySelector('pre.sample')).toHaveStyle({ borderRadius: '0' }));
    expect(container.querySelector('pre code')?.textContent).toBe(code);
  });

  it('loads the real renderer and preserves C++ highlighting', async () => {
    const { container } = render(<CodeHighlighter code="int main() { return 0; }" language="c++" />);
    await waitFor(() => expect(container.querySelector('code span')).toBeInTheDocument());
    expect(container.querySelector('code')?.textContent).toBe('int main() { return 0; }');
  });
});
