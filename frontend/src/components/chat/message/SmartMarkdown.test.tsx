import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { message } from 'antd';
import { StrictMode } from 'react';
import SmartMarkdown from './SmartMarkdown';
import katex from 'katex';

vi.mock('../../../i18n/hooks', () => ({ useT: () => (key: string) => key }));
vi.mock('../../common/CodeHighlighter', () => ({ default: ({ code, language }: { code: string; language?: string }) => <pre data-language={language}><code>{code}</code></pre> }));
vi.mock('../../common/CodeBlockPreview', () => ({ default: ({ isStreaming }: { isStreaming: boolean }) => <span data-testid="preview-state">{String(isStreaming)}</span> }));

describe('SmartMarkdown code state', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps a completed code block collapsed while later text streams', () => {
    const content = '```javascript\nconst stable = 1;\n```\n\n';
    const { rerender } = render(<SmartMarkdown content={content} isStreaming />);
    fireEvent.click(screen.getByText('javascript'));
    expect(screen.queryByText('const stable = 1;')).not.toBeInTheDocument();
    rerender(<SmartMarkdown content={`${content}Later text`} isStreaming />);
    expect(screen.queryByText('const stable = 1;')).not.toBeInTheDocument();
    expect(screen.getByText('Later text')).toBeInTheDocument();
  });

  it('preserves collapse when an incomplete fence closes', () => {
    const { rerender } = render(<SmartMarkdown content={'```javascript\nconst value = 1;'} isStreaming />);
    expect(screen.getByTestId('preview-state')).toHaveTextContent('true');
    fireEvent.click(screen.getByText('javascript'));
    rerender(<SmartMarkdown content={'```javascript\nconst value = 1;\n```'} isStreaming />);
    expect(screen.getByTestId('preview-state')).toHaveTextContent('false');
    expect(screen.queryByText('const value = 1;')).not.toBeInTheDocument();
  });

  it.each(['```', '~~~', '````'])('renders unlabeled %s fences as blocks and inline code as inline', (fence) => {
    const { container } = render(<SmartMarkdown content={`Inline \`one\`\n\n${fence}\nblock code\n${fence}`} />);
    expect(screen.getByText('text')).toBeInTheDocument();
    expect(container.querySelector('pre code')).toHaveTextContent('block code');
    expect(container.querySelector('p code')).toHaveTextContent('one');
    expect(container.querySelector('pre pre')).not.toBeInTheDocument();
  });

  it('preserves the complete c++ language token', () => {
    const { container } = render(<SmartMarkdown content={'```c++\nint main() {}\n```'} />);
    expect(container.querySelector('pre')).toHaveAttribute('data-language', 'c++');
  });

  it('recognizes a closed fence inside a block quote while later content is streaming', () => {
    render(<SmartMarkdown content={'> ```javascript\n> const quoted = 1;\n> ```'} isStreaming />);
    expect(screen.getByTestId('preview-state')).toHaveTextContent('false');
  });

  it('preserves copied feedback during stream appends and cleans its timer on unmount in StrictMode', async () => {
    vi.useFakeTimers();
    const scheduled = vi.spyOn(globalThis, 'setTimeout');
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.spyOn(message, 'success').mockImplementation(() => Object.assign(() => undefined, { then: vi.fn(), promise: Promise.resolve(true) }));
    const content = '```javascript\nconst copied = 1;\n```\n\n';
    const { rerender, unmount } = render(<StrictMode><SmartMarkdown content={content} isStreaming /></StrictMode>);
    await act(async () => fireEvent.click(screen.getByRole('img', { name: 'copy' })));
    expect(writeText).toHaveBeenCalledWith('const copied = 1;');
    expect(screen.getByRole('img', { name: 'check' })).toBeInTheDocument();
    rerender(<StrictMode><SmartMarkdown content={`${content}More text`} isStreaming /></StrictMode>);
    expect(screen.getByRole('img', { name: 'check' })).toBeInTheDocument();
    const copyTimerIndex = scheduled.mock.calls.findIndex(([, delay]) => delay === 500);
    expect(copyTimerIndex).toBeGreaterThanOrEqual(0);
    const copyTimer = scheduled.mock.results[copyTimerIndex].value;
    unmount();
    expect(cleared).toHaveBeenCalledWith(copyTimer);
  });
});

describe('SmartMarkdown streaming math', () => {
  it('typesets a fixed formula once across 30 ordinary text appends', () => {
    const typeset = vi.spyOn(katex, 'renderToString');
    const content = '$x_{streamCacheRegression}$\n\n';
    const { rerender } = render(<SmartMarkdown content={content} isStreaming />);
    for (let i = 1; i <= 30; i++) {
      rerender(<SmartMarkdown content={content + 'more '.repeat(i)} isStreaming />);
    }
    expect(typeset).toHaveBeenCalledTimes(1);
  });

  it('recovers through partial delimiters and invalid TeX while preserving nearby fence offsets', () => {
    const { container, rerender } = render(<SmartMarkdown content="$" isStreaming />);
    for (const content of ['$\\frac', '$\\frac{1}{$', '$\\frac{1}{2}$']) {
      rerender(<SmartMarkdown content={content} isStreaming />);
    }
    expect(container.querySelector('.katex-error')).not.toBeInTheDocument();
    expect(container.querySelector('.katex')).toBeInTheDocument();
    rerender(<SmartMarkdown content={'$\\frac{1}{2}$\n\n> ```javascript\n> const value = 1;\n> ```'} isStreaming />);
    expect(screen.getByTestId('preview-state')).toHaveTextContent('false');
    rerender(<SmartMarkdown content={'$\\frac{1}{2}$\n\n```javascript\nconst value = 1;'} isStreaming />);
    expect(screen.getByTestId('preview-state')).toHaveTextContent('true');
  });
});

describe('SmartMarkdown model delimiter integration', () => {
  it('reuses bracket-delimited math through 30 text appends and equivalent dollar syntax', () => {
    const typeset = vi.spyOn(katex, 'renderToString');
    const formula = 'x_{bracketCacheRegression}';
    const content = `\\(${formula}\\)\n\n`;
    const { rerender } = render(<SmartMarkdown content={content} isStreaming />);
    for (let i = 1; i <= 30; i++) {
      rerender(<SmartMarkdown content={content + 'more '.repeat(i)} isStreaming />);
    }
    rerender(<SmartMarkdown content={`$${formula}$`} />);
    expect(typeset).toHaveBeenCalledTimes(1);
  });

  it.each(['\n', '\r\n'])('keeps fence streaming state after Unicode and model math (%j)', (eol) => {
    const prefix = ['中文😀 \\(x^*\\)', '', '\\[y\\]', ''].join(eol);
    const { rerender } = render(<SmartMarkdown content={prefix + eol + '```javascript' + eol + 'const n = 1;'} isStreaming />);
    expect(screen.getByTestId('preview-state')).toHaveTextContent('true');
    rerender(<SmartMarkdown content={prefix + eol + '> ```javascript' + eol + '> const n = 1;' + eol + '> ```'} isStreaming />);
    expect(screen.getByTestId('preview-state')).toHaveTextContent('false');
    rerender(<SmartMarkdown content={prefix + eol + '- ```javascript' + eol + '  const n = 1;' + eol + '  ```'} isStreaming />);
    expect(screen.getByTestId('preview-state')).toHaveTextContent('false');
  });

  it('keeps a completed code block collapsed as bracket math arrives', () => {
    const content = '```javascript\nconst stable = 1;\n```\n\n';
    const { rerender } = render(<SmartMarkdown content={content} isStreaming />);
    fireEvent.click(screen.getByText('javascript'));
    for (const tail of ['\\(', '\\(x', '\\(x\\)', '\\(x\\) later text']) {
      rerender(<SmartMarkdown content={content + tail} isStreaming />);
      expect(screen.queryByText('const stable = 1;')).not.toBeInTheDocument();
    }
  });
});
