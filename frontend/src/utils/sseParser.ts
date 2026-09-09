import type { SSEFrame, StreamEvent } from '../types/sse';
import type { SSEMessage, ToolCall } from '../types/conversation';

/** 保存跨 chunk 的 UTF-8、行与 frame 边界。 */
export class SSEParser {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private buffer = '';
  private data: string[] = [];
  private event: string | undefined;

  push(chunk: Uint8Array): SSEFrame[] {
    return this.consume(this.decoder.decode(chunk, { stream: true }), false);
  }

  finish(): SSEFrame[] {
    return this.consume(this.decoder.decode(), true);
  }

  private consume(text: string, eof: boolean): SSEFrame[] {
    this.buffer += text;
    const frames: SSEFrame[] = [];
    const dispatch = () => {
      if (this.data.length) frames.push({ data: this.data.join('\n'), event: this.event });
      this.data = [];
      this.event = undefined;
    };
    const line = (value: string) => {
      if (!value) { dispatch(); return; }
      if (value.startsWith(':')) return;
      const colon = value.indexOf(':');
      const field = colon < 0 ? value : value.slice(0, colon);
      const raw = colon < 0 ? '' : value.slice(colon + 1);
      const content = raw.startsWith(' ') ? raw.slice(1) : raw;
      if (field === 'data') this.data.push(content);
      if (field === 'event') this.event = content;
    };
    let start = 0;
    for (let index = 0; index < this.buffer.length; index += 1) {
      const char = this.buffer[index];
      if (char !== '\r' && char !== '\n') continue;
      if (char === '\r' && index === this.buffer.length - 1 && !eof) break;
      line(this.buffer.slice(start, index));
      if (char === '\r' && this.buffer[index + 1] === '\n') index += 1;
      start = index + 1;
    }
    this.buffer = this.buffer.slice(start);
    if (eof) {
      if (this.buffer) line(this.buffer);
      this.buffer = '';
      dispatch();
    }
    return frames;
  }
}

const eventTypes = ['node_start', 'node_end', 'graph_complete', 'title_update', 'task_start', 'task_complete', 'task_error', 'conversation_created'] as const;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;
}
function toolCalls(value: unknown): ToolCall[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error('Invalid SSE tool calls');
  return value.map(item => {
    if (!record(item) || (item.function != null && !record(item.function))) throw new Error('Invalid SSE tool call');
    const fn = record(item.function) ? item.function : {};
    return {
      id: string(item.id), index: typeof item.index === 'number' ? item.index : undefined,
      type: 'function', function: { name: string(fn.name) ?? '', arguments: string(fn.arguments) ?? '' }
    };
  });
}

/** 只接受已知事件结构；开放字段在此边界收窄。 */
export function parseSSEFrame(frame: SSEFrame): StreamEvent | null {
  if (frame.data.trim() === '[DONE]') return { kind: 'done' };
  if (frame.event && frame.event !== 'message' && !eventTypes.some(type => type === frame.event)) return null;
  const value: unknown = JSON.parse(frame.data);
  if (!record(value)) throw new Error('Invalid SSE event');
  const type = value.type ?? (frame.event === 'message' ? undefined : frame.event);
  if (type !== undefined && !eventTypes.some(known => known === type)) return null;
  const message: SSEMessage = {};
  for (const known of eventTypes) if (known === type) message.type = known;
  message.task_id = string(value.task_id);
  message.conversation_id = string(value.conversation_id);
  message.title = string(value.title);
  message.tags = strings(value.tags);
  message.node_name = string(value.node_name);
  message.level = typeof value.level === 'number' ? value.level : undefined;
  message.task_description = string(value.task_description);
  message.agent_name = string(value.agent_name);
  message.success = typeof value.success === 'boolean' ? value.success : undefined;
  message.result = string(value.result);
  message.final_result = string(value.final_result);
  if (Array.isArray(value.execution_chain) && value.execution_chain.every(row => strings(row))) message.execution_chain = value.execution_chain.map(row => strings(row) ?? []);
  if (value.error !== undefined) {
    const text = string(value.error) ?? (record(value.error) ? string(value.error.message) : undefined);
    if (!text) throw new Error('Invalid SSE error');
    message.error = { message: text, type: record(value.error) ? string(value.error.type) ?? 'error' : 'error' };
  }
  if (message.type?.startsWith('task_') && !message.task_id) throw new Error('Missing SSE task ID');
  if (message.type === 'conversation_created' && !message.conversation_id) throw new Error('Missing SSE conversation ID');
  if (value.choices !== undefined) {
    if (!Array.isArray(value.choices)) throw new Error('Invalid SSE choices');
    message.choices = value.choices.map(choice => {
      if (!record(choice) || (choice.delta !== undefined && !record(choice.delta))) throw new Error('Invalid SSE delta');
      const delta = record(choice.delta) ? choice.delta : {};
      for (const field of ['content', 'reasoning_content', 'reasoning']) {
        if (delta[field] != null && typeof delta[field] !== 'string') throw new Error('Invalid SSE content');
      }
      return {
        delta: { content: string(delta.content), reasoning_content: string(delta.reasoning_content), reasoning: string(delta.reasoning), tool_calls: toolCalls(delta.tool_calls) },
        finish_reason: choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls' ? choice.finish_reason : null
      };
    });
  }
  if (value.role === 'tool') {
    message.role = 'tool'; message.tool_call_id = string(value.tool_call_id); message.content = string(value.content);
    if (!message.tool_call_id || message.content === undefined) throw new Error('Invalid SSE tool result');
  }
  if (record(value.usage)) {
    const usage = value.usage;
    if (typeof usage.total_tokens === 'number' && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
      message.usage = { total_tokens: usage.total_tokens, prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens };
      if (record(usage.completion_tokens_details) && typeof usage.completion_tokens_details.reasoning_tokens === 'number') {
        message.usage.completion_tokens_details = { reasoning_tokens: usage.completion_tokens_details.reasoning_tokens };
      }
    }
  }
  if (record(value.completion) && typeof value.completion.message === 'string') {
    message.completion = { message: value.completion.message, tool_name: string(value.completion.tool_name), graph_name: string(value.completion.graph_name) };
  }
  if (record(value.incomplete) && typeof value.incomplete.message === 'string') {
    message.incomplete = { message: value.incomplete.message, missing_fields: strings(value.incomplete.missing_fields) ?? [] };
  }
  if (!message.type && !message.error && !message.choices && !message.role && !message.usage && !message.completion && !message.incomplete) return null;
  return { kind: 'message', message };
}
