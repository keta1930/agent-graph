import { useState, useCallback, useRef, useEffect } from 'react';
import { ConversationService, generateMongoId } from '../services/conversationService';
import type { ChatSubmitOptions, ConversationMode, EnhancedStreamingState, SSEMessage } from '../types/conversation';
import { getSessionGeneration, isCurrentSession, registerSessionReset } from '../utils/authSession';
import { getErrorMessage } from '../utils/errors';
import { SSEParser, parseSSEFrame } from '../utils/sseParser';
import { initialStreamingState, reduceStream } from '../utils/sseReducer';

export interface SSEConnectionOptions extends ChatSubmitOptions {
  mode: ConversationMode;
  conversationId?: string;
  onOpen?: () => void;
  onMessage?: (message: SSEMessage) => void;
  onComplete?: () => void | Promise<void>;
  onError?: (error: string) => void;
  onConversationCreated?: (conversationId: string) => void;
  onTitleUpdate?: (data: { title?: string; tags?: string[]; conversation_id?: string }) => void;
}

interface Connection {
  controller: AbortController;
  session: number;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  state: EnhancedStreamingState;
  frame?: number;
  terminal: boolean;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try { await reader.cancel(); } catch { /* 断开的传输仍需释放 reader。 */ }
}
function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try { reader.releaseLock(); } catch { /* pending read 将在取消完成后自行退出。 */ }
}

export function useSSEConnection() {
  const [enhancedStreamingState, setState] = useState(initialStreamingState);
  const connectionRef = useRef<Connection | null>(null);
  const mountedRef = useRef(true);

  const closeConnection = useCallback(() => {
    const connection = connectionRef.current;
    if (!connection) return;
    connectionRef.current = null;
    if (connection.frame !== undefined) cancelAnimationFrame(connection.frame);
    connection.controller.abort();
    if (connection.reader) void cancelReader(connection.reader);
    if (!connection.terminal) {
      connection.terminal = true;
      connection.state = reduceStream(connection.state, { type: 'terminal', status: 'aborted' });
      if (mountedRef.current) setState(connection.state);
    }
  }, []);

  const resetStreamingState = useCallback(() => {
    closeConnection();
    setState(initialStreamingState);
  }, [closeConnection]);

  const startConnection = useCallback(async (inputText: string, options: SSEConnectionOptions): Promise<string> => {
    closeConnection();
    const connection: Connection = {
      controller: new AbortController(), session: getSessionGeneration(), terminal: false,
      state: { ...initialStreamingState, status: 'connecting', isStreaming: true }
    };
    connectionRef.current = connection;
    setState(connection.state);
    const owns = () => mountedRef.current && connectionRef.current === connection && isCurrentSession(connection.session) && !connection.controller.signal.aborted;
    const flush = () => {
      if (connection.frame !== undefined) cancelAnimationFrame(connection.frame);
      connection.frame = undefined;
      if (owns()) setState(connection.state);
    };
    const terminal = (status: 'completed' | 'error', error?: string) => {
      if (!owns() || connection.terminal) return;
      connection.terminal = true;
      connection.state = reduceStream(connection.state, { type: 'terminal', status, error });
      flush();
      if (status === 'error') options.onError?.(error ?? 'Stream failed');
      else if (options.onComplete) void Promise.resolve(options.onComplete()).catch(error => console.error('Conversation completion failed', getErrorMessage(error)));
    };
    const conversationId = options.conversationId ?? generateMongoId();
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      const signal = connection.controller.signal;
      if (options.mode === 'agent') {
        reader = await ConversationService.createAgentRunSSE({
          agent_name: options.agent_name, user_prompt: options.user_prompt ?? inputText,
          conversation_id: conversationId, project_id: options.project_id, model_name: options.model_name,
          system_prompt: options.system_prompt, mcp_servers: options.mcp_servers ?? [], system_tools: options.system_tools ?? [],
          max_iterations: options.max_iterations, files: options.files ?? []
        }, { signal });
      } else {
        if (!options.graph_name) throw new Error('Graph is required');
        reader = await ConversationService.createGraphSSE({ graph_name: options.graph_name, input_text: inputText,
          conversation_id: options.conversationId, continue_from_checkpoint: options.continue_from_checkpoint ?? false
        }, { signal });
      }
    } catch (error) {
      if (owns()) terminal('error', getErrorMessage(error, 'Connection failed'));
      if (connectionRef.current === connection) connectionRef.current = null;
      throw error;
    }
    if (!owns()) {
      await cancelReader(reader);
      releaseReader(reader);
      throw new DOMException('Connection cancelled', 'AbortError');
    }
    connection.reader = reader;
    connection.state = { ...connection.state, status: 'streaming' };
    flush();
    options.onOpen?.();

    const consume = async () => {
      const parser = new SSEParser();
      let sequence = 0;
      let explicitComplete = false;
      try {
        while (owns() && !connection.terminal) {
          const { done, value } = await reader.read();
          if (!owns()) break;
          const frames = done ? parser.finish() : parser.push(value);
          for (const frame of frames) {
            if (!owns() || connection.terminal) break;
            const event = parseSSEFrame(frame);
            if (!event) continue;
            if (event.kind === 'done') { terminal('completed'); break; }
            const message = event.message;
            connection.state = reduceStream(connection.state, { type: 'event', event, id: `stream-${sequence++}`, timestamp: Date.now() });
            if (message.error && message.type !== 'task_error') { terminal('error', message.error.message); break; }
            options.onMessage?.(message);
            if (!owns()) break;
            if (message.type === 'conversation_created' && message.conversation_id) options.onConversationCreated?.(message.conversation_id);
            if (!owns()) break;
            if (message.type === 'title_update') options.onTitleUpdate?.(message);
            if (message.type === 'graph_complete') explicitComplete = true;
          }
          if (done && owns() && !connection.terminal) terminal(explicitComplete ? 'completed' : 'error', explicitComplete ? undefined : 'Stream ended before completion');
          if (owns() && !connection.terminal && connection.frame === undefined) {
            connection.frame = requestAnimationFrame(() => { connection.frame = undefined; flush(); });
          }
        }
      } catch (error) {
        if (owns()) terminal('error', getErrorMessage(error, 'Stream read failed'));
      } finally {
        if (connection.frame !== undefined) cancelAnimationFrame(connection.frame);
        await cancelReader(reader);
        releaseReader(reader);
        if (connectionRef.current === connection) connectionRef.current = null;
      }
    };
    // 调用者在握手成功后确认提交，后续流错误由唯一终态回调处理。
    void consume();
    return conversationId;
  }, [closeConnection]);

  useEffect(() => {
    mountedRef.current = true;
    const unregister = registerSessionReset(resetStreamingState);
    return () => { mountedRef.current = false; unregister(); closeConnection(); };
  }, [closeConnection, resetStreamingState]);

  return { streamingState: enhancedStreamingState, enhancedStreamingState, startConnection, closeConnection, resetStreamingState };
}
