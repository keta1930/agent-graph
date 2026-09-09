import type { EnhancedStreamingState, StreamingBlock, ToolCall } from '../types/conversation';
import type { StreamAction } from '../types/sse';

export const initialStreamingState: EnhancedStreamingState = {
  status: 'idle', isStreaming: false, blocks: [], error: null, nodeInfo: null
};

function mergeToolCalls(previous: ToolCall[], incoming: ToolCall[]): ToolCall[] {
  const calls = [...previous];
  for (const call of incoming) {
    const index = calls.findIndex(item => call.index !== undefined ? item.index === call.index : call.id ? item.id === call.id : calls.length === 1);
    if (index < 0) { calls.push(call); continue; }
    const old = calls[index];
    calls[index] = { ...old, id: call.id ?? old.id, function: {
      name: old.function.name + call.function.name,
      arguments: old.function.arguments + call.function.arguments
    } };
  }
  return calls;
}

/** 同一输入得到同一状态，主流与各 task 独立收集块。 */
export function reduceStream(state: EnhancedStreamingState, action: StreamAction): EnhancedStreamingState {
  if (action.type === 'terminal') {
    return { ...state, status: action.status, isStreaming: false, error: action.error ?? state.error,
      blocks: state.blocks.map(block => ({ ...block, isComplete: true,
        taskStatus: block.taskStatus === 'running' ? (action.status === 'completed' ? 'completed' : 'failed') : block.taskStatus,
        nodeInfo: block.nodeInfo ? { ...block.nodeInfo, status: 'completed' } : undefined
      })), nodeInfo: state.nodeInfo ? { ...state.nodeInfo, status: 'completed' } : null };
  }
  if (action.event.kind === 'done') return reduceStream(state, { type: 'terminal', status: 'completed' });
  const message = action.event.message;
  let blocks = state.blocks;
  const owner = (block: StreamingBlock) => block.taskId === message.task_id;
  const create = (type: StreamingBlock['type'], content = ''): StreamingBlock => ({
    id: `${action.id}-${type}`, timestamp: action.timestamp, type, content, isComplete: false, taskId: message.task_id
  });
  const complete = (predicate: (block: StreamingBlock) => boolean) => {
    blocks = blocks.map(block => predicate(block) && !block.isComplete ? { ...block, isComplete: true } : block);
  };
  if (message.type === 'task_start') {
    if (blocks.some(block => block.type === 'task' && owner(block))) return state;
    return { ...state, blocks: [...blocks, { ...create('task', message.task_description), taskStatus: 'running' }] };
  }
  if (message.type === 'task_error' || message.type === 'task_complete') {
    const failed = message.type === 'task_error' || message.success === false;
    complete(owner);
    blocks = blocks.map(block => block.type === 'task' && owner(block) ? { ...block,
      taskStatus: failed ? 'failed' : 'completed', content: message.error?.message ?? message.result ?? block.content
    } : block);
    return { ...state, blocks };
  }
  if (message.error) return reduceStream(state, { type: 'terminal', status: 'error', error: message.error.message });
  if (message.type === 'node_start') {
    complete(block => owner(block) && block.type !== 'task');
    const nodeInfo = { nodeName: message.node_name ?? '', level: message.level ?? 0, status: 'running' as const };
    return { ...state, nodeInfo, blocks: [...blocks, { ...create('node_start'), nodeInfo }] };
  }
  if (message.type === 'node_end') {
    complete(owner);
    blocks = blocks.map(block => owner(block) && block.nodeInfo ? { ...block, nodeInfo: { ...block.nodeInfo, status: 'completed' } } : block);
    return { ...state, blocks, nodeInfo: state.nodeInfo ? { ...state.nodeInfo, status: 'completed' } : null };
  }
  const append = (type: 'reasoning' | 'content', text: string | undefined) => {
    if (!text) return;
    const index = blocks.findIndex(block => owner(block) && block.type === type && !block.isComplete);
    blocks = index < 0 ? [...blocks, create(type, text)] : blocks.map((block, i) => i === index ? { ...block, content: block.content + text } : block);
  };
  for (const choice of message.choices ?? []) {
    append('reasoning', choice.delta?.reasoning_content ?? choice.delta?.reasoning);
    append('content', choice.delta?.content);
    if (choice.delta?.tool_calls?.length) {
      complete(block => owner(block) && (block.type === 'reasoning' || block.type === 'content'));
      const calls = choice.delta.tool_calls;
      const index = blocks.findIndex(block => owner(block) && block.type === 'tool_calls' && !block.isComplete);
      blocks = index < 0 ? [...blocks, { ...create('tool_calls'), toolCalls: calls }] : blocks.map((block, i) => i === index ? { ...block, toolCalls: mergeToolCalls(block.toolCalls ?? [], calls) } : block);
    }
    if (choice.finish_reason) complete(block => owner(block) && (block.type === 'reasoning' || block.type === 'content'));
  }
  if (message.role === 'tool' && message.tool_call_id) {
    const callId = message.tool_call_id;
    blocks = blocks.map(block => {
      if (!owner(block) || !block.toolCalls?.some(call => call.id === callId)) return block;
      // content 仅由本 reducer 生成，保持现有工具结果展示协议。
      const results: Record<string, string> = block.content ? JSON.parse(block.content) : {};
      results[callId] = message.content ?? '';
      return { ...block, content: JSON.stringify(results), isComplete: block.toolCalls.every(call => call.id !== undefined && call.id in results) };
    });
  }
  return blocks === state.blocks ? state : { ...state, blocks };
}
