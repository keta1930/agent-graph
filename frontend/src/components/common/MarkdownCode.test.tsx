import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ReactMarkdown from 'react-markdown';
import MarkdownCode from './MarkdownCode';

vi.mock('./CodeHighlighter', () => ({ default: ({ code, language }: { code: string; language?: string }) => <pre data-testid="highlight" data-language={language}>{code}</pre> }));

it('keeps inline code inline and handles c++, no-language and incomplete fences', () => {
  const content = '`inline`\n\n```c++\nint n = 1;\n```\n\n```\nplain code\n```\n\n```python\nunfinished';
  render(<ReactMarkdown components={{ pre: MarkdownCode }}>{content}</ReactMarkdown>);
  expect(screen.getByText('inline').tagName).toBe('CODE');
  const blocks = screen.getAllByTestId('highlight');
  expect(blocks).toHaveLength(3);
  expect(blocks[0]).toHaveAttribute('data-language', 'c++');
  expect(blocks[1]).toHaveTextContent('plain code');
  expect(blocks[2]).toHaveTextContent('unfinished');
});
