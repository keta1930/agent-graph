import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StreamingBlockDisplay from './StreamingBlockDisplay';
import type { StreamingBlock } from '../../../types/conversation';

vi.mock('../../../i18n/hooks', () => ({ useT: () => (key: string) => key }));
vi.mock('./ToolCallDisplay', () => ({ default: () => null }));
vi.mock('./NodeExecutionInfo', () => ({ default: () => null }));
vi.mock('../../common/CodeHighlighter', () => ({ default: ({ code }: { code: string }) => <pre>{code}</pre> }));
vi.mock('../../common/CodeBlockPreview', () => ({ default: ({ isStreaming, conversationId }: { isStreaming: boolean; conversationId?: string }) => <span data-testid="preview" data-conversation={conversationId}>{String(isStreaming)}</span> }));

describe('streaming reasoning', () => {
  it('passes stream completion and conversation context through expanded reasoning', () => {
    const block: StreamingBlock = { id: 'reasoning', timestamp: 0, type: 'reasoning', content: '$x$\n\n```javascript\nconst n = 1;', isComplete: false };
    const { container, rerender } = render(<StreamingBlockDisplay block={block} renderingMode="agent" conversationId="conversation-1" />);
    fireEvent.click(screen.getByText('pages.chatSystem.messageDisplay.aiThinking'));
    expect(container.querySelector('.katex')).toBeInTheDocument();
    expect(screen.getByTestId('preview')).toHaveTextContent('true');
    expect(screen.getByTestId('preview')).toHaveAttribute('data-conversation', 'conversation-1');
    rerender(<StreamingBlockDisplay block={{ ...block, isComplete: true }} renderingMode="agent" conversationId="conversation-1" />);
    expect(screen.getByTestId('preview')).toHaveTextContent('false');
  });
});
