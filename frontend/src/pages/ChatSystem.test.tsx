import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { Suspense } from 'react';
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChatSystem from './ChatSystem';
import { I18nProvider } from '../i18n/I18nContext';
import { useConversationStore } from '../store/conversationStore';
import { ConversationService } from '../services/conversationService';
import { invalidateSession } from '../utils/authSession';
import type { SSEConnectionOptions } from '../hooks/useSSEConnection';
import type { ConversationDetail, ChatSubmitOptions } from '../types/conversation';

const stream = vi.hoisted(() => ({ start: vi.fn(), close: vi.fn(), reset: vi.fn(), tour: vi.fn(), success: vi.fn(), remove: vi.fn(), send: undefined as ((text: string, options?: ChatSubmitOptions) => Promise<void>) | undefined, state: { isStreaming: false, blocks: [], error: null, nodeInfo: null } }));
vi.mock('../hooks/useSSEConnection', () => ({ useSSEConnection: () => ({ streamingState: stream.state, enhancedStreamingState: stream.state, startConnection: stream.start, closeConnection: stream.close, resetStreamingState: stream.reset }) }));
vi.mock('../components/tour', () => ({ useTour: () => ({ startTour: stream.tour }), chatTourSteps: [] }));
vi.mock('../hooks/useGlobalNotification', () => ({ useGlobalNotification: () => ({ notifications: [], removeNotification: stream.remove, success: stream.success }) }));
vi.mock('../components/chat/sidebar/ConversationSidebar', () => ({ default: ({ onConversationSelect, onNewConversation }: { onConversationSelect: (id: string) => void; onNewConversation: () => void }) => <><button onClick={() => onConversationSelect('B')}>select B</button><button onClick={onNewConversation}>new conversation</button></> }));
vi.mock('../components/chat/message/MessageDisplay', () => ({ default: ({ conversation, pendingUserMessage }: { conversation: ConversationDetail; pendingUserMessage?: string }) => <div data-testid="history">{conversation.conversation_id}:{conversation.title}:{conversation.rounds.flatMap(round => round.messages.map(message => message.content)).join(',')}:{pendingUserMessage}</div> }));
vi.mock('../components/chat/input/InputArea', async () => {
  const { useState } = await import('react');
  type Props = { conversationId?: string; disabled?: boolean; onSendMessage: (text: string, options?: ChatSubmitOptions) => Promise<void> };
  function InputSession({ conversationId, disabled, onSendMessage }: Props) {
    const [draft, setDraft] = useState('');
    stream.send = onSendMessage;
    return <><textarea aria-label="continuation" data-conversation-id={conversationId} disabled={disabled} value={draft} onChange={event => setDraft(event.target.value)} /><button disabled={disabled} onClick={() => { void onSendMessage(draft || 'pending-B', { model_name: 'model' }); }}>send</button></>;
  }
  return { default: (props: Props) => <InputSession key={props.conversationId} {...props} /> };
});
vi.mock('../components/chat/input/ModeSelector', () => ({ default: ({ disabled, onStartConversation }: { disabled?: boolean; onStartConversation: (text: string, options: ChatSubmitOptions) => Promise<void> }) => <><textarea aria-label="new message" disabled={disabled} /><button disabled={disabled} onClick={() => { void onStartConversation('new graph', { mode: 'graph', graph_name: 'graph' }); }}>new graph</button><button disabled={disabled} onClick={() => { void onStartConversation('new agent', { mode: 'agent', model_name: 'model' }); }}>new agent</button></> }));
vi.mock('../components/chat/modal/CompactConfigModal', () => ({ default: ({ onConfirm }: { onConfirm: (config: { modelName: string; compactType: 'precise'; threshold: number }) => Promise<void> }) => <button onClick={() => { void onConfirm({ modelName: 'model', compactType: 'precise', threshold: 100 }); }}>compact</button> }));
vi.mock('../components/common/GlobalNotification', () => ({ default: () => null }));
vi.mock('../components/chat/drawer', () => ({ DocumentsDrawer: () => null }));
vi.mock('../components/conversation-file/FileViewModal', () => ({ FileViewModal: () => null }));
vi.mock('../components/chat/ShareModal', () => ({ default: () => null }));
vi.mock('../components/chat/ShareButton', () => ({ default: () => null }));

function detail(id: string, title = id): ConversationDetail { return { conversation_id: id, title, type: 'agent', rounds: [] }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function Controls() {
  const navigate = useNavigate(); const location = useLocation();
  return <><div data-testid="url">{location.pathname}</div><button onClick={() => navigate('/chat/A')}>A</button><button onClick={() => navigate('/chat/B')}>B</button><button onClick={() => navigate('/chat')}>empty</button><button onClick={() => navigate(-1)}>back</button></>;
}
function mount(path = '/chat/A') {
  return render(<I18nProvider><App><MemoryRouter initialEntries={[path]}><Controls /><Routes><Route path="/chat/:conversationId?" element={<ChatSystem />} /></Routes></MemoryRouter></App></I18nProvider>);
}
function lastOptions(): SSEConnectionOptions { return stream.start.mock.lastCall?.[1]; }
beforeEach(() => {
  stream.state.isStreaming = false; stream.send = undefined;
  stream.start.mockReset(); stream.close.mockClear(); stream.reset.mockClear(); stream.success.mockClear();
  stream.start.mockImplementation(async (_text: string, options: SSEConnectionOptions) => { options.onOpen?.(); return options.conversationId ?? 'generated'; });
  useConversationStore.getState().clearCurrentConversation();
  vi.spyOn(ConversationService, 'getConversationDetail').mockImplementation(async id => detail(id));
  vi.spyOn(ConversationService, 'updateInputConfig').mockResolvedValue(undefined);
  vi.spyOn(ConversationService, 'getConversations').mockResolvedValue({ conversations: [], total_count: 0 });
});
describe('ChatSystem URL and async ownership', () => {
  it('clears stale details for A → B → empty and handles browser back', async () => {
    mount(); await screen.findByText('A:A::');
    const b = deferred<ConversationDetail>(); vi.mocked(ConversationService.getConversationDetail).mockReturnValueOnce(b.promise);
    fireEvent.click(screen.getByText('B'));
    expect(screen.queryByTestId('history')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('empty'));
    await act(async () => { b.resolve(detail('B')); });
    expect(screen.getByTestId('url')).toHaveTextContent('/chat');
    expect(screen.queryByTestId('history')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('back'));
    await screen.findByText('B:B::');
    expect(stream.close).toHaveBeenCalledTimes(4);
  });
  it('does not let an old completion after config save reload A or clear B pending', async () => {
    const save = deferred<void>(); vi.mocked(ConversationService.updateInputConfig).mockReturnValue(save.promise);
    mount(); await screen.findByText('A:A::'); fireEvent.click(screen.getByText('send'));
    const a = lastOptions(); let completion: void | Promise<void>;
    act(() => { completion = a.onComplete?.(); });
    fireEvent.click(screen.getByText('B')); await screen.findByText('B:B::');
    fireEvent.click(screen.getByText('send'));
    await act(async () => { save.resolve(); await completion; });
    expect(screen.getByTestId('history')).toHaveTextContent('B:B::pending-B');
    expect(ConversationService.getConversationDetail).toHaveBeenCalledTimes(2);
    act(() => a.onTitleUpdate?.({ title: 'old title', conversation_id: 'A' }));
    expect(screen.getByTestId('history')).not.toHaveTextContent('old title');
  });
  it('invalidates callbacks across A → B → A and patches the latest detail snapshot', async () => {
    mount(); await screen.findByText('A:A::'); fireEvent.click(screen.getByText('send')); const old = lastOptions();
    fireEvent.click(screen.getByText('B')); await screen.findByText('B:B::');
    fireEvent.click(screen.getByText('A')); await screen.findByText('A:A::');
    act(() => old.onTitleUpdate?.({ title: 'stale', conversation_id: 'A' }));
    expect(screen.getByTestId('history')).not.toHaveTextContent('stale');
    fireEvent.click(screen.getByText('send')); const current = lastOptions();
    act(() => useConversationStore.getState().patchCurrentConversation('A', { rounds: [{ round: 1, messages: [{ role: 'assistant', content: 'latest round' }] }] }));
    act(() => current.onTitleUpdate?.({ title: 'latest title', conversation_id: 'A' }));
    expect(screen.getByTestId('history')).toHaveTextContent('latest title:latest round');
  });
  it('adopts the server graph ID without cancelling the current stream and clears blocks after history loads', async () => {
    mount('/chat'); fireEvent.click(screen.getByText('new graph'));
    await waitFor(() => expect(screen.getByTestId('history')).toHaveTextContent('new graph'));
    const options = lastOptions(); const closeCount = stream.close.mock.calls.length;
    act(() => options.onConversationCreated?.('server-graph'));
    expect(screen.getByTestId('url')).toHaveTextContent('/chat/server-graph');
    expect(stream.close).toHaveBeenCalledTimes(closeCount);
    act(() => options.onTitleUpdate?.({ conversation_id: 'server-graph', title: 'graph title' }));
    expect(screen.getByTestId('history')).toHaveTextContent('graph title');
    const resetBefore = stream.reset.mock.calls.length;
    await act(async () => { await options.onComplete?.(); });
    expect(ConversationService.updateInputConfig).toHaveBeenCalledWith('server-graph', expect.objectContaining({ selected_graph: 'graph' }));
    expect(ConversationService.getConversationDetail).toHaveBeenCalledWith('server-graph', expect.anything());
    expect(stream.reset).toHaveBeenCalledTimes(resetBefore + 1);
  });
  it('ignores late compact completion after switching to B', async () => {
    const compact = deferred<Awaited<ReturnType<typeof ConversationService.compactConversation>>>();
    vi.spyOn(ConversationService, 'compactConversation').mockReturnValue(compact.promise);
    mount(); await screen.findByText('A:A::'); fireEvent.click(screen.getByText('compact'));
    fireEvent.click(screen.getByText('B')); await screen.findByText('B:B::');
    await act(async () => { compact.resolve({ status: 'success', message: 'ok', conversation_id: 'A', compact_type: 'precise' }); });
    expect(ConversationService.getConversationDetail).toHaveBeenCalledTimes(2);
    expect(stream.success).not.toHaveBeenCalled();
    expect(screen.getByTestId('history')).toHaveTextContent('B:B::');
  });
});

it('does not let a completed previous submission clear a newer pending message in the same conversation', async () => {
  const save = deferred<void>(); vi.mocked(ConversationService.updateInputConfig).mockReturnValueOnce(save.promise);
  mount(); await screen.findByText('A:A::'); fireEvent.click(screen.getByText('send'));
  await act(async () => undefined);
  const previous = lastOptions(); let completion: void | Promise<void>;
  act(() => { completion = previous.onComplete?.(); });
  fireEvent.click(screen.getByText('send'));
  await act(async () => { save.resolve(); await completion; });
  expect(screen.getByTestId('history')).toHaveTextContent('pending-B');
  expect(ConversationService.getConversationDetail).toHaveBeenCalledTimes(1);
});

// BrowserRouter changes browser history before its transition commits route params.
// Suspending only the destination holds that exact boundary without delaying SSE/HTTP.
function mountWithDelayedAdoption(shouldDelay: (id: string) => boolean = () => true) {
  const gate = deferred<void>();
  let released = false;
  function Destination() {
    const { conversationId } = useParams();
    if (conversationId && shouldDelay(conversationId) && !released) throw gate.promise;
    return <ChatSystem />;
  }
  window.history.replaceState(null, '', '/chat');
  const view = render(<I18nProvider><App><BrowserRouter><Controls /><Suspense fallback={<div>route loading</div>}><Routes><Route path="/chat" element={<Destination />} /><Route path="/chat/:conversationId" element={<Destination />} /></Routes></Suspense></BrowserRouter></App></I18nProvider>);
  return { release: async () => { await act(async () => { released = true; gate.resolve(); }); }, unmount: view.unmount };
}

describe('ChatSystem deferred BrowserRouter adoption', () => {
  it.each(['graph', 'agent'] as const)('keeps %s input unavailable until route adoption after terminal history loads', async mode => {
    const { release } = mountWithDelayedAdoption();
    fireEvent.click(screen.getByRole('button', { name: `new ${mode}` }));
    await act(async () => undefined);
    const options = lastOptions();
    if (mode === 'graph') act(() => options.onConversationCreated?.('server-graph'));
    const target = decodeURIComponent(window.location.pathname.slice('/chat/'.length));
    expect(target).toBeTruthy();
    await act(async () => { await options.onComplete?.(); });
    expect(ConversationService.getConversationDetail).toHaveBeenCalledWith(target, expect.anything());
    // No editable input may be offered while the committed route is still /chat.
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.queryByRole('textbox', { name: 'new message' })).not.toBeInTheDocument();
    expect(screen.getByTestId('history')).toHaveTextContent(target);
    await act(async () => { await stream.send?.('too early'); });
    expect(stream.start).toHaveBeenCalledTimes(1);
    const closes = stream.close.mock.calls.length;
    await release();
    const input = screen.getByRole('textbox', { name: 'continuation' });
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute('data-conversation-id', target);
    expect(stream.close).toHaveBeenCalledTimes(closes);
    fireEvent.change(input, { target: { value: 'immediate continuation' } });
    await act(async () => undefined);
    expect(screen.getByRole('textbox', { name: 'continuation' })).toBe(input);
    expect(input).toHaveValue('immediate continuation');
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(stream.start).toHaveBeenLastCalledWith('immediate continuation', expect.objectContaining({ conversationId: target }));
  });
});


it('keeps input disabled across a committed temporary ID followed by a delayed server ID', async () => {
  const { release } = mountWithDelayedAdoption(id => id === 'server-graph');
  fireEvent.click(screen.getByRole('button', { name: 'new graph' }));
  await act(async () => undefined);
  const options = lastOptions();
  const temporaryId = screen.getByRole('textbox').getAttribute('data-conversation-id');
  expect(temporaryId).toBeTruthy();
  const closes = stream.close.mock.calls.length;
  act(() => options.onConversationCreated?.('server-graph'));
  await act(async () => { await options.onComplete?.(); });
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByTestId('history')).toHaveTextContent('server-graph');
  await release();
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(screen.getByRole('textbox')).toHaveAttribute('data-conversation-id', 'server-graph');
  expect(stream.close).toHaveBeenCalledTimes(closes);
});

it('stops the submission while letting its pending route adoption finish without reviving callbacks', async () => {
  const { release } = mountWithDelayedAdoption();
  fireEvent.click(screen.getByRole('button', { name: 'new graph' }));
  await act(async () => undefined);
  const options = lastOptions();
  act(() => {
    options.onConversationCreated?.('server-graph');
    stream.state.isStreaming = true;
    useConversationStore.getState().setCurrentMode('graph');
  });
  const closes = stream.close.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
  act(() => {
    stream.state.isStreaming = false;
    useConversationStore.getState().setCurrentMode('agent');
  });
  expect(stream.close).toHaveBeenCalledTimes(closes + 1);
  expect(screen.getByRole('textbox')).toBeDisabled();
  await act(async () => { await options.onComplete?.(); options.onConversationCreated?.('late-id'); });
  expect(ConversationService.updateInputConfig).not.toHaveBeenCalled();
  expect(window.location.pathname).toBe('/chat/server-graph');
  await release();
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(screen.getByRole('textbox')).toHaveAttribute('data-conversation-id', 'server-graph');
  expect(stream.close).toHaveBeenCalledTimes(closes + 1);
});

it.each(['stream', 'config', 'history'] as const)('releases adoption after a %s error and permits a retry', async failure => {
  const { release } = mountWithDelayedAdoption();
  fireEvent.click(screen.getByRole('button', { name: 'new graph' }));
  await act(async () => undefined);
  const options = lastOptions();
  act(() => options.onConversationCreated?.('server-graph'));
  if (failure === 'config') vi.mocked(ConversationService.updateInputConfig).mockRejectedValueOnce(new Error('config failure'));
  if (failure === 'history') vi.mocked(ConversationService.getConversationDetail).mockRejectedValueOnce(new Error('history failure'));
  await act(async () => {
    if (failure === 'stream') options.onError?.('stream failure');
    else await options.onComplete?.();
  });
  expect(screen.getByRole('textbox')).toBeDisabled();
  await release();
  expect(screen.getByRole('textbox')).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  expect(stream.start).toHaveBeenCalledTimes(2);
  expect(lastOptions().conversationId).toBe('server-graph');
});

it.each(['new conversation', 'select B'])('abandons a pending adoption on explicit %s navigation', async action => {
  const { release } = mountWithDelayedAdoption();
  fireEvent.click(screen.getByRole('button', { name: 'new graph' }));
  await act(async () => undefined);
  const old = lastOptions();
  act(() => old.onConversationCreated?.('server-graph'));
  fireEvent.click(screen.getByRole('button', { name: action }));
  await act(async () => { await old.onComplete?.(); old.onConversationCreated?.('late-id'); });
  expect(ConversationService.updateInputConfig).not.toHaveBeenCalled();
  await release();
  expect(window.location.pathname).toBe(action === 'new conversation' ? '/chat' : '/chat/B');
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(screen.queryByTestId('history')?.textContent ?? '').not.toContain('server-graph');
  expect(screen.getByRole('textbox')).toHaveAccessibleName(action === 'new conversation' ? 'new message' : 'continuation');
});

it('invalidates a pending adoption across auth reset and unmount, then permits a new session to start', async () => {
  const first = mountWithDelayedAdoption();
  fireEvent.click(screen.getByRole('button', { name: 'new graph' }));
  await act(async () => undefined);
  const old = lastOptions();
  act(() => old.onConversationCreated?.('server-graph'));
  act(() => invalidateSession());
  first.unmount();
  await act(async () => { await old.onComplete?.(); old.onConversationCreated?.('late-id'); });
  expect(ConversationService.updateInputConfig).not.toHaveBeenCalled();
  await first.release();
  const next = mountWithDelayedAdoption();
  expect(screen.getByRole('textbox', { name: 'new message' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'new agent' }));
  await act(async () => undefined);
  expect(stream.start).toHaveBeenCalledTimes(2);
  await next.release();
  expect(screen.getByRole('textbox', { name: 'continuation' })).toBeEnabled();
});
