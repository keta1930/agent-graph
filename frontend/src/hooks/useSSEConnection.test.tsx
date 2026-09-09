import { Profiler, StrictMode, type PropsWithChildren } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSSEConnection } from './useSSEConnection';
import { ConversationService } from '../services/conversationService';
import { invalidateSession } from '../utils/authSession';

vi.mock('../services/conversationService', () => ({ ConversationService: { createAgentRunSSE: vi.fn(), createGraphSSE: vi.fn() }, generateMongoId: () => 'new-id' }));
const create = vi.mocked(ConversationService.createAgentRunSSE);
const encode = (text: string) => new TextEncoder().encode(text);
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const reader = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }).getReader();
  return { reader, cancel, push: (wire: string) => controller.enqueue(encode(wire)), end: () => controller.close(), fail: () => controller.error(new Error('read failed')) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { create.mockReset(); });
describe('useSSEConnection', () => {
  it('cancels a late handshake and never lets old finally replace the new connection', async () => {
    const a = stream(); const b = stream(); const late = deferred<typeof a.reader>();
    create.mockReturnValueOnce(late.promise).mockResolvedValueOnce(b.reader);
    const onCompleteA = vi.fn(); const onCompleteB = vi.fn();
    const { result } = renderHook(useSSEConnection);
    let first!: Promise<unknown>;
    act(() => { first = result.current.startConnection('A', { mode: 'agent', onComplete: onCompleteA }).catch(error => error); });
    await act(() => result.current.startConnection('B', { mode: 'agent', onComplete: onCompleteB }));
    expect(create.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => { late.resolve(a.reader); await first; });
    expect(a.cancel).toHaveBeenCalledOnce();
    await act(async () => { b.push('data:{"choices":[{"delta":{"content":"B"}}]}\n\ndata:[DONE]\n\n'); });
    await waitFor(() => expect(onCompleteB).toHaveBeenCalledOnce());
    expect(onCompleteA).not.toHaveBeenCalled();
    expect(result.current.streamingState.blocks[0].content).toBe('B');
  });
  it('batches 50 tokens into at most 5 commits and flushes DONE without an animation frame', async () => {
    const wire = stream(); create.mockResolvedValue(wire.reader);
    const onComplete = vi.fn(); let commits = 0;
    function Measure({ children }: PropsWithChildren) { return <Profiler id="stream" onRender={() => { commits += 1; }}>{children}</Profiler>; }
    const { result } = renderHook(useSSEConnection, { wrapper: Measure });
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(123);
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    await act(() => result.current.startConnection('hello', { mode: 'agent', onComplete }));
    const before = commits;
    await act(async () => { wire.push(Array.from({ length: 50 }, () => 'data:{"choices":[{"delta":{"content":"x"}}]}\n\n').join('')); });
    await act(async () => { wire.push('data:[DONE]\n\n'); });
    expect(result.current.streamingState.blocks[0].content).toBe('x'.repeat(50));
    expect(commits - before).toBeLessThanOrEqual(5);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(frame).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledWith(123);
    expect(result.current.streamingState.status).toBe('completed');
  });
  it.each(['data:{"error":"failed"}\n\ndata:[DONE]\n\n', 'data:{"choices":[{"delta":{"content":"partial"}}]}', 'data:{"choices":'])('ends error exactly once for terminal error, EOF and invalid JSON', async wireText => {
    const wire = stream(); create.mockResolvedValue(wire.reader);
    const onError = vi.fn(); const onComplete = vi.fn();
    const { result } = renderHook(useSSEConnection);
    await act(() => result.current.startConnection('hello', { mode: 'agent', onError, onComplete }));
    await act(async () => { wire.push(wireText); wire.end(); });
    await waitFor(() => expect(result.current.streamingState.isStreaming).toBe(false));
    expect(onError).toHaveBeenCalledOnce(); expect(onComplete).not.toHaveBeenCalled();
    if (wireText.includes('partial')) expect(result.current.streamingState.blocks[0].content).toBe('partial');
  });
  it('keeps task errors local and delivers callbacks once in order', async () => {
    const wire = stream(); create.mockResolvedValue(wire.reader);
    const events: string[] = [];
    const { result } = renderHook(useSSEConnection);
    await act(() => result.current.startConnection('hello', { mode: 'agent', onTitleUpdate: () => events.push('title'), onComplete: () => { events.push('complete'); }, onError: () => events.push('error') }));
    await act(async () => { wire.push('data:{"type":"task_start","task_id":"A"}\n\ndata:{"type":"task_error","task_id":"A","error":"task failed"}\n\ndata:{"type":"title_update","title":"new"}\n\ndata:[DONE]\n\n'); });
    expect(events).toEqual(['title', 'complete']);
    expect(result.current.streamingState.blocks[0]).toMatchObject({ taskStatus: 'failed', content: 'task failed' });
  });
  it('consumes read rejection and silently cancels pending reads on reset/unmount', async () => {
    const a = stream(); const b = stream(); create.mockResolvedValueOnce(a.reader).mockResolvedValueOnce(b.reader);
    const onError = vi.fn(); const onComplete = vi.fn();
    const { result, unmount } = renderHook(useSSEConnection);
    await act(() => result.current.startConnection('A', { mode: 'agent', onError }));
    await act(async () => { a.fail(); });
    expect(onError).toHaveBeenCalledOnce();
    await act(() => result.current.startConnection('B', { mode: 'agent', onError, onComplete }));
    act(() => invalidateSession());
    expect(b.cancel).toHaveBeenCalledOnce();
    expect(result.current.streamingState.status).toBe('idle');
    unmount(); expect(onError).toHaveBeenCalledOnce(); expect(onComplete).not.toHaveBeenCalled();
  });
});

it('accepts graph_complete as an explicit EOF terminal and does not signal success twice', async () => {
  const wire = stream(); vi.mocked(ConversationService.createGraphSSE).mockResolvedValue(wire.reader);
  const onComplete = vi.fn(); const onError = vi.fn();
  const { result } = renderHook(useSSEConnection);
  await act(() => result.current.startConnection('graph', { mode: 'graph', graph_name: 'graph', onComplete, onError }));
  await act(async () => { wire.push('data:{"type":"graph_complete"}\n\n'); wire.end(); });
  expect(onComplete).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled();
  act(() => result.current.closeConnection()); expect(onComplete).toHaveBeenCalledOnce();
});

it('keeps received text when stopping and consumes reader cancel/release failures', async () => {
  const wire = stream(); create.mockResolvedValue(wire.reader);
  const onError = vi.fn(); const onComplete = vi.fn();
  const { result, unmount } = renderHook(useSSEConnection);
  await act(() => result.current.startConnection('hello', { mode: 'agent', onError, onComplete }));
  await act(async () => { wire.push('data:{"choices":[{"delta":{"content":"keep"}}]}\n\n'); });
  vi.spyOn(wire.reader, 'cancel').mockRejectedValue(new Error('cancel failed'));
  const release = vi.spyOn(wire.reader, 'releaseLock').mockImplementation(() => { throw new Error('release failed'); });
  await act(async () => { result.current.closeConnection(); wire.fail(); });
  expect(result.current.streamingState).toMatchObject({ status: 'aborted', blocks: [{ content: 'keep', isComplete: true }] });
  expect(release).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled(); expect(onComplete).not.toHaveBeenCalled();
  unmount();
});


it('does not replay title or terminal callbacks under StrictMode', async () => {
  const wire = stream(); create.mockResolvedValue(wire.reader);
  const onTitleUpdate = vi.fn(); const onComplete = vi.fn();
  const { result } = renderHook(useSSEConnection, { wrapper: StrictMode });
  await act(() => result.current.startConnection('hello', { mode: 'agent', onTitleUpdate, onComplete }));
  await act(async () => { wire.push('data:{"type":"title_update","title":"title"}\n\ndata:[DONE]\n\n'); });
  expect(onTitleUpdate).toHaveBeenCalledOnce(); expect(onComplete).toHaveBeenCalledOnce();
});
