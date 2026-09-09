import { describe, expect, it } from 'vitest';
import { initialStreamingState, reduceStream } from './sseReducer';
import type { EnhancedStreamingState, SSEMessage } from '../types/conversation';

function apply(state: EnhancedStreamingState, message: SSEMessage, id = 'event') {
  return reduceStream(state, { type: 'event', event: { kind: 'message', message }, id, timestamp: 100 });
}
describe('reduceStream', () => {
  it('isolates main / task A / task B content, tools and completion', () => {
    let state = initialStreamingState;
    for (const task_id of ['A', 'B']) state = apply(state, { type: 'task_start', task_id }, task_id);
    for (const task_id of ['A', undefined, 'B', 'A', undefined, 'B']) state = apply(state, { task_id, choices: [{ delta: { content: task_id ?? 'main' } }] }, task_id ?? 'main');
    expect(state.blocks.filter(block => block.type === 'content').map(block => block.content)).toEqual(['AA', 'mainmain', 'BB']);
    state = apply(state, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'tool', arguments: '{' } }] } }] });
    expect(state.blocks.find(block => block.taskId === 'A' && block.type === 'content')?.isComplete).toBe(false);
    state = apply(state, { type: 'task_error', task_id: 'A', error: { message: 'failed A', type: 'error' } });
    expect(state.error).toBeNull();
    expect(state.blocks.find(block => block.taskId === 'A' && block.type === 'task')).toMatchObject({ taskStatus: 'failed', content: 'failed A' });
    expect(state.blocks.find(block => block.taskId === 'B' && block.type === 'content')?.isComplete).toBe(false);
  });
  it('does not mutate previous nested node or tool snapshots and is deterministic', () => {
    const state = apply(initialStreamingState, { type: 'node_start', node_name: 'node', level: 2 });
    Object.freeze(state.nodeInfo);
    Object.freeze(state.blocks[0].nodeInfo);
    const next = apply(state, { type: 'node_end' });
    expect(state.nodeInfo?.status).toBe('running');
    expect(next.nodeInfo?.status).toBe('completed');
    expect(apply(state, { type: 'node_end' })).toEqual(next);
  });
  it('merges tool arguments and stores results separately for matching owners', () => {
    let state = apply(initialStreamingState, { task_id: 'A', choices: [{ delta: { tool_calls: [{ index: 0, id: 'same', function: { name: 'tool', arguments: '{' } }] } }] });
    const old = state;
    state = apply(state, { task_id: 'A', choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '', arguments: '}' } }] } }] });
    expect(old.blocks[0].toolCalls?.[0].function.arguments).toBe('{');
    expect(state.blocks[0].toolCalls?.[0].function.arguments).toBe('{}');
    expect(apply(state, { role: 'tool', tool_call_id: 'same', content: 'wrong owner' }).blocks[0].content).toBe('');
    expect(apply(state, { task_id: 'A', role: 'tool', tool_call_id: 'same', content: 'result' }).blocks[0].content).toBe('{"same":"result"}');
  });
});
