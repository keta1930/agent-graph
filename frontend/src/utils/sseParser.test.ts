import { describe, expect, it } from 'vitest';
import { SSEParser, parseSSEFrame } from './sseParser';

const encoder = new TextEncoder();
describe('SSEParser', () => {
  it('preserves UTF-8, CRLF, comments, multiline data and DONE at every byte boundary', () => {
    const wire = ': heartbeat\r\nevent: message\r\ndata:{"choices":\r\ndata: [{"delta":{"content":"中文🙂"}}]}\r\n\r\ndata:[DONE]';
    const bytes = encoder.encode(wire);
    for (let split = 1; split < bytes.length; split += 1) {
      const parser = new SSEParser();
      const frames = [...parser.push(bytes.slice(0, split)), ...parser.push(bytes.slice(split)), ...parser.finish()];
      expect(frames.map(parseSSEFrame)).toMatchObject([
        { kind: 'message', message: { choices: [{ delta: { content: '中文🙂' } }] } }, { kind: 'done' }
      ]);
    }
  });
  it('keeps partial frames until EOF and reports malformed or incomplete payloads', () => {
    const parser = new SSEParser();
    expect(parser.push(encoder.encode('data: {"choices":'))).toEqual([]);
    expect(() => parser.finish().map(parseSSEFrame)).toThrow();
    const utf8 = new SSEParser();
    utf8.push(new Uint8Array([0xe4]));
    expect(() => utf8.finish()).toThrow();
  });
  it('ignores unknown events and validates known event shapes', () => {
    expect(parseSSEFrame({ event: 'unknown', data: 'not-json' })).toBeNull();
    expect(parseSSEFrame({ data: '{"type":"unknown","error":"ignored"}' })).toBeNull();
    expect(() => parseSSEFrame({ data: '{"type":"task_error","error":"failed"}' })).toThrow('task ID');
    expect(() => parseSSEFrame({ data: '{"choices":[{"delta":{"content":42}}]}' })).toThrow('content');
  });
  it.each(['"failed"', '{"message":"failed","type":"execution"}'])('normalizes error %s', error => {
    expect(parseSSEFrame({ data: `{"error":${error}}` })).toMatchObject({ kind: 'message', message: { error: { message: 'failed' } } });
  });
  it.each([undefined, null, []])('accepts absent or empty tool calls: %s', tool_calls => {
    const event = parseSSEFrame({ data: JSON.stringify({ choices: [{ delta: { tool_calls, content: 'text' } }] }) });
    expect(event).toMatchObject({ kind: 'message', message: { choices: [{ delta: { content: 'text' } }] } });
  });
  it.each([undefined, null])('normalizes an absent tool function increment: %s', fn => {
    const event = parseSSEFrame({ data: JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: fn }] } }] }) });
    expect(event).toMatchObject({ kind: 'message', message: { choices: [{ delta: {
      tool_calls: [{ index: 0, function: { name: '', arguments: '' } }]
    } }] } });
  });
  it.each([{}, 1, false, 'invalid', [null], [1], [{ function: [] }], [{ function: 'invalid' }], [{ function: 1 }]])('rejects malformed non-null tool data: %s', tool_calls => {
    expect(() => parseSSEFrame({ data: JSON.stringify({ choices: [{ delta: { tool_calls } }] }) })).toThrow('Invalid SSE tool call');
  });
});
