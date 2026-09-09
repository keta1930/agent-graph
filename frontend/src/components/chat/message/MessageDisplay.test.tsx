import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type ReactMarkdown from 'react-markdown';
import type { ConversationDetail, EnhancedStreamingState, StreamingBlock } from '../../../types/conversation';
import MessageDisplay from './MessageDisplay';

const { markdownRender, translate } = vi.hoisted(() => ({
  markdownRender: vi.fn(),
  translate: (key: string) => key,
}));
vi.mock('../../../i18n/hooks', () => ({ useT: () => translate }));
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  return { ...actual, default: (props: ComponentProps<typeof ReactMarkdown>) => {
    markdownRender(props.children);
    return <actual.default {...props} />;
  } };
});
vi.mock('../../common/CodeHighlighter', () => ({ default: ({ code }: { code: string }) => <pre><code>{code}</code></pre> }));
vi.mock('../../common/CodeBlockPreview', () => ({ default: () => null }));

const history = (): ConversationDetail => ({
  conversation_id: 'history', title: 'History', type: 'agent',
  rounds: Array.from({ length: 100 }, (_, round) => ({ round, messages: [{ role: 'assistant', content: `History ${round}` }] })),
});
const stream = (blocks: StreamingBlock[]): EnhancedStreamingState => ({ isStreaming: true, blocks, error: null, nodeInfo: null });
const contentBlock = (content: string): StreamingBlock => ({ id: 'stream', type: 'content', content, isComplete: false, timestamp: 1 });

describe('MessageDisplay update boundaries', () => {
  beforeEach(() => markdownRender.mockClear());

  it('does not render any of 100 fixed historical Markdown messages during 50 stream appends', () => {
    const conversation = history();
    const { rerender } = render(<MessageDisplay conversation={conversation} enhancedStreamingState={stream([contentBlock('A')])} />);
    expect(markdownRender.mock.calls.filter(([content]) => String(content).startsWith('History '))).toHaveLength(100);
    markdownRender.mockClear();
    for (let index = 1; index <= 50; index++) {
      rerender(<MessageDisplay conversation={{ ...conversation }} enhancedStreamingState={stream([contentBlock('A'.repeat(index + 1))])} />);
    }
    expect(markdownRender.mock.calls.filter(([content]) => String(content).startsWith('History '))).toHaveLength(0);
    expect(screen.getByText('A'.repeat(51))).toBeInTheDocument();
  });

  it('updates an earlier history round when the array length and last round stay unchanged', () => {
    const conversation = history();
    const { rerender } = render(<MessageDisplay conversation={conversation} />);
    const rounds = conversation.rounds.map((round, index) => index === 0 ? { ...round, messages: [{ role: 'assistant' as const, content: 'Edited earlier history' }] } : round);
    rerender(<MessageDisplay conversation={{ ...conversation, rounds }} />);
    expect(screen.getByText('Edited earlier history')).toBeInTheDocument();
    expect(screen.queryByText('History 0')).not.toBeInTheDocument();
  });

  it('updates task status without changing block content or completion', () => {
    const conversation = { ...history(), rounds: [] };
    const task: StreamingBlock = { id: 'task', type: 'task', taskId: 'one', taskStatus: 'running', content: '', timestamp: 1, isComplete: false };
    const { container, rerender } = render(<MessageDisplay conversation={conversation} enhancedStreamingState={stream([task])} />);
    expect(container.querySelector('[data-task-status="running"]')).toBeInTheDocument();
    rerender(<MessageDisplay conversation={conversation} enhancedStreamingState={stream([{ ...task, taskStatus: 'failed' }])} />);
    expect(container.querySelector('[data-task-status="failed"]')).toBeInTheDocument();
  });

  it('refreshes task history and keeps its expanded state', () => {
    const conversation: ConversationDetail = {
      ...history(), rounds: [{ round: 1, messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'call', function: { name: 'delegate', arguments: '{}' } }] }] }],
      tasks: [{ task_id: 'one', agent_name: 'Researcher', rounds: [{ round: 1, tool_call_id: 'call', messages: [{ role: 'assistant', content: 'Old task answer' }] }] }],
    };
    const { rerender } = render(<MessageDisplay conversation={conversation} />);
    fireEvent.click(screen.getByText('Task one'));
    expect(screen.getByText('Old task answer')).toBeInTheDocument();
    rerender(<MessageDisplay conversation={{ ...conversation, tasks: [{ task_id: 'one', agent_name: 'Researcher', rounds: [{ round: 1, tool_call_id: 'call', messages: [{ role: 'assistant', content: 'New task answer' }] }] }] }} />);
    expect(screen.getByText('New task answer')).toBeInTheDocument();
  });

  it('updates the graph execution chain without changing rounds', () => {
    const conversation: ConversationDetail = { ...history(), rounds: [], type: 'graph', execution_chain: [['before']] };
    const { rerender } = render(<MessageDisplay conversation={conversation} />);
    rerender(<MessageDisplay conversation={{ ...conversation, execution_chain: [['after']] }} />);
    expect(screen.getByText('after')).toBeInTheDocument();
    expect(screen.queryByText('before')).not.toBeInTheDocument();
  });

  it.each(['completed', 'error', 'aborted'] as const)('retains %s text until the stream is explicitly cleared', (status) => {
    const conversation = { ...history(), rounds: [] };
    const state = { ...stream([{ ...contentBlock('Received before terminal'), isComplete: true }]), status, isStreaming: false };
    const { rerender } = render(<MessageDisplay conversation={conversation} enhancedStreamingState={state} />);
    expect(screen.getByText('Received before terminal')).toBeInTheDocument();
    expect(screen.queryByText('▋')).not.toBeInTheDocument();
    rerender(<MessageDisplay conversation={conversation} enhancedStreamingState={{ ...state, blocks: [] }} />);
    expect(screen.queryByText('Received before terminal')).not.toBeInTheDocument();
  });

  it('keeps interleaved main and task messages separate and displays task-local tool results and errors', () => {
    const task = (taskId: string): StreamingBlock => ({ id: `task-${taskId}`, type: 'task', taskId, taskStatus: 'running', content: '', timestamp: 1, isComplete: false });
    const first = task('one');
    const blocks: StreamingBlock[] = [
      first,
      { ...contentBlock('Task one content'), id: 'one-content', taskId: 'one' },
      contentBlock('Main content'),
      task('two'),
      { ...contentBlock('Task two content'), id: 'two-content', taskId: 'two' },
      { id: 'tool', taskId: 'one', type: 'tool_calls', timestamp: 1, isComplete: false, content: '{"task-call":"Task-local result"}', toolCalls: [{ id: 'task-call', function: { name: 'lookup', arguments: '{}' } }] },
    ];
    const conversation = { ...history(), rounds: [] };
    const { container, rerender } = render(<MessageDisplay conversation={conversation} enhancedStreamingState={stream(blocks)} />);
    const headers = container.querySelectorAll('.task-block-header');
    headers.forEach(header => fireEvent.click(header));
    expect(screen.getAllByText('Task one content')).toHaveLength(1);
    expect(screen.getAllByText('Task two content')).toHaveLength(1);
    const tasks = container.querySelectorAll('.task-block-container');
    expect(within(tasks[0] as HTMLElement).getByText('Task-local result')).toBeInTheDocument();
    expect(tasks[0]).not.toHaveTextContent('Task two content');
    expect(tasks[1]).not.toHaveTextContent('Main content');
    rerender(<MessageDisplay conversation={conversation} enhancedStreamingState={stream([{ ...first, taskStatus: 'failed', content: 'Task failed after output' }, ...blocks.slice(1)])} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Task failed after output');
    expect(screen.getByText('Task one content')).toBeInTheDocument();
  });
});
