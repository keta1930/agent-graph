import type { SSEMessage } from './conversation';

export interface SSEFrame {
  data: string;
  event?: string;
}

export type StreamEvent =
  | { kind: 'done' }
  | { kind: 'message'; message: SSEMessage };

export type StreamAction =
  | { type: 'event'; event: StreamEvent; id: string; timestamp: number }
  | { type: 'terminal'; status: 'completed' | 'error' | 'aborted'; error?: string };
