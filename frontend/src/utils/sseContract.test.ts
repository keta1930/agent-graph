import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useSSEConnection } from '../hooks/useSSEConnection';
import { ConversationService } from '../services/conversationService';
import { SSEParser, parseSSEFrame } from './sseParser';
import { initialStreamingState, reduceStream } from './sseReducer';

vi.mock('../services/conversationService', () => ({
  ConversationService: { createAgentRunSSE: vi.fn(), createGraphSSE: vi.fn() }, generateMongoId: () => 'contract-conversation'
}));

interface ContractCase {
  name: string;
  requests: { tools_present: boolean; stream: boolean }[];
  frames: string[];
}

let cases: ContractCase[];
beforeAll(() => {
  // 每次测试都经过真实 SDK 与 Python 生产者，缺少环境时直接失败。
  const output = execFileSync('uv', ['run', '--no-sync', '--no-env-file', 'python', 'tests/contracts/export_sse_contract.py'], {
    cwd: resolve(__dirname, '../../..'),
    env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30_000
  });
  cases = JSON.parse(output) as ContractCase[];
}, 35_000);

function getCase(name: string): ContractCase {
  const item = cases.find(item => item.name === name);
  if (!item) throw new Error(`Missing production SSE case: ${name}`);
  return item;
}

function consume(name: string) {
  const parser = new SSEParser();
  const bytes = new TextEncoder().encode(getCase(name).frames.join(''));
  // 逐字节传输也必须保留 UTF-8 和 SSE 边界。
  const frames = Array.from(bytes).flatMap(byte => parser.push(new Uint8Array([byte])));
  const events = [...frames, ...parser.finish()].map(parseSSEFrame).filter(event => event !== null);
  const state = events.reduce((state, event, index) => reduceStream(state, {
    type: 'event', event, id: `contract-${index}`, timestamp: 1
  }), initialStreamingState);
  return { events, state };
}

describe('production Python → TypeScript SSE contract', () => {
  it('consumes role, text, empty finish delta and usage with no tools configured', () => {
    expect(getCase('plain').requests).toEqual([{ tools_present: false, stream: true }]);
    const { events, state } = consume('plain');
    expect(state).toMatchObject({ status: 'completed', error: null, blocks: [{ type: 'content', content: '你好🙂', isComplete: true }] });
    expect(state.blocks).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'message', message: expect.objectContaining({
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, completion_tokens_details: { reasoning_tokens: 1 } }
    }) }));
    expect(events.filter(event => event.kind === 'done')).toHaveLength(1);
  });

  it.each(['reasoning_content', 'reasoning'])('keeps %s separate from the answer', name => {
    expect(consume(name).state.blocks).toMatchObject([
      { type: 'reasoning', content: '思考', isComplete: true }, { type: 'content', content: '回答', isComplete: true }
    ]);
  });

  it.each(['tools', 'nullable_function'])('merges %s increments and attaches the production tool result', name => {
    expect(getCase(name).requests.every(request => request.tools_present)).toBe(true);
    const { state } = consume(name);
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]).toMatchObject({ type: 'tool_calls', isComplete: true,
      toolCalls: [{ id: 'call-0', index: 0, function: { name: 'contract_tool', arguments: '{}' } }]
    });
    expect(state.blocks[0].toolCalls).toHaveLength(1);
    expect(JSON.parse(state.blocks[0].content)).toEqual({ 'call-0': 'contract tool result' });
    expect(state.blocks[1]).toMatchObject({ type: 'content', content: '你好🙂', isComplete: true });
  });

  it('preserves production task ownership', () => {
    expect(consume('task').state.blocks).toMatchObject([{ taskId: 'contract-task', type: 'content', content: '你好🙂' }]);
  });

  it.each(['length', 'content_filter'])('accepts %s finish chunks and completes at DONE', name => {
    const { state } = consume(name);
    expect(state.status).toBe('completed');
    expect(state.error).toBeNull();
    if (name === 'length') expect(state.blocks).toMatchObject([{ content: 'partial', isComplete: true }]);
  });

  it('consumes the graph lifecycle producers', () => {
    const { events, state } = consume('graph');
    expect(events).toContainEqual(expect.objectContaining({ kind: 'message', message: expect.objectContaining({
      type: 'graph_complete', final_result: 'contract final', execution_chain: [['contract-node']]
    }) }));
    expect(state).toMatchObject({ status: 'completed', nodeInfo: { nodeName: 'contract-node', status: 'completed' } });
  });

  it.each(['plain', 'agent_error', 'graph_error'])('delivers one terminal callback for production %s', async name => {
    const reader = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(getCase(name).frames.join('')));
      controller.close();
    } }).getReader();
    vi.mocked(ConversationService.createAgentRunSSE).mockResolvedValue(reader);
    const onComplete = vi.fn(); const onError = vi.fn();
    const { result } = renderHook(useSSEConnection);
    await act(() => result.current.startConnection('public contract input', { mode: 'agent', onComplete, onError }));
    await waitFor(() => expect(result.current.streamingState.isStreaming).toBe(false));
    if (name === 'plain') {
      expect(onComplete).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      expect(result.current.streamingState.blocks).toMatchObject([{ content: '你好🙂' }]);
    } else {
      expect(onError).toHaveBeenCalledOnce();
      expect(onComplete).not.toHaveBeenCalled();
      expect(result.current.streamingState.status).toBe('error');
    }
  });
});
