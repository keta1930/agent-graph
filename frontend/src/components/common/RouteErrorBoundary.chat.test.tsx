import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { ConversationService } from '../../services/conversationService';
import { useConversationStore } from '../../store/conversationStore';
import { setToken, setUserInfo } from '../../utils/auth';
import { invalidateSession } from '../../utils/authSession';
import type { ChatSubmitOptions, ConversationDetail, ConversationMode } from '../../types/conversation';

const lifecycle = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn(), tour: vi.fn(), committedIds: [] as Array<string | undefined> }));
vi.mock('../tour', () => ({ useTour: () => ({ startTour: lifecycle.tour }), chatTourSteps: [] }));
vi.mock('../chat/sidebar/ConversationSidebar', () => ({
  default: function SidebarProbe({ onConversationSelect }: { onConversationSelect: (id: string) => void }) {
    const { conversationId } = useParams();
    useEffect(() => { lifecycle.mounted(); return lifecycle.unmounted; }, []);
    useEffect(() => { lifecycle.committedIds.push(conversationId); }, [conversationId]);
    return <><span data-testid="committed-id">{conversationId ?? 'new'}</span><button onClick={() => onConversationSelect('other')}>Other conversation</button></>;
  },
}));
vi.mock('../chat/input/ModeSelector', () => ({
  default: ({ onStartConversation, onModeSelect }: {
    onStartConversation: (text: string, options: ChatSubmitOptions) => Promise<void>;
    onModeSelect: (mode: ConversationMode) => void;
  }) => <>
    <button onClick={() => { onModeSelect('agent'); void onStartConversation('Agent request', { mode: 'agent', model_name: 'model' }); }}>Start agent</button>
    <button onClick={() => { onModeSelect('graph'); void onStartConversation('Graph request', { mode: 'graph', graph_name: 'graph' }); }}>Start graph</button>
  </>,
}));
vi.mock('../chat/input/InputArea', () => ({ default: () => null }));
vi.mock('../chat/modal/CompactConfigModal', () => ({ default: () => null }));
vi.mock('../chat/drawer', () => ({ DocumentsDrawer: () => null }));
vi.mock('../conversation-file/FileViewModal', () => ({ FileViewModal: () => null }));
vi.mock('../chat/ShareModal', () => ({ default: () => null }));
vi.mock('../chat/ShareButton', () => ({ default: () => null }));

function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const reader = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }).getReader();
  return {
    reader,
    cancel,
    push: (event: string) => controller.enqueue(new TextEncoder().encode(`data:${event}\n\n`)),
  };
}

function history(id: string, mode: ConversationMode): ConversationDetail {
  return {
    conversation_id: id,
    title: 'Persisted title',
    type: mode,
    rounds: [{ round: 1, messages: [{ role: 'assistant', content: 'Persisted answer' }] }],
  };
}

beforeEach(() => {
  lifecycle.committedIds.length = 0;
  localStorage.clear();
  localStorage.setItem('app_locale', 'en');
  localStorage.setItem('chat-tour-completed', 'true');
  setToken('routing-test-token');
  setUserInfo({ user_id: 'routing-test-user', role: 'normal' });
  invalidateSession();
  useConversationStore.getState().clearCurrentConversation();
  window.history.replaceState(null, '', '/chat');
  vi.spyOn(ConversationService, 'getConversations').mockResolvedValue({ conversations: [], total_count: 0 });
  vi.spyOn(ConversationService, 'updateInputConfig').mockResolvedValue(undefined);
});

describe('application routing and live chat streams', () => {
  it.each(['agent', 'graph'] as const)('keeps a new %s stream alive through ID navigation until DONE', async mode => {
    const wire = stream();
    let signal: AbortSignal | undefined;
    vi.spyOn(ConversationService, 'createAgentRunSSE').mockImplementation(async (_request, options) => {
      signal = options?.signal;
      return wire.reader;
    });
    vi.spyOn(ConversationService, 'createGraphSSE').mockImplementation(async (_request, options) => {
      signal = options?.signal;
      return wire.reader;
    });
    const getDetail = vi.spyOn(ConversationService, 'getConversationDetail').mockImplementation(async id => history(id, mode));
    render(<StrictMode><App /></StrictMode>);
    const start = await screen.findByRole('button', { name: `Start ${mode}` });
    const mountsBefore = lifecycle.mounted.mock.calls.length;
    const unmountsBefore = lifecycle.unmounted.mock.calls.length;
    fireEvent.click(start);

    await waitFor(() => expect(window.location.pathname).toMatch(/^\/chat\/.+/));
    const temporaryId = window.location.pathname.slice('/chat/'.length);
    expect(signal?.aborted).toBe(false);
    expect(wire.cancel).not.toHaveBeenCalled();
    expect(getDetail).not.toHaveBeenCalled();

    let finalId = temporaryId;
    if (mode === 'graph') {
      finalId = 'server-graph-id';
      await act(async () => { wire.push(JSON.stringify({ type: 'conversation_created', conversation_id: finalId })); });
      await waitFor(() => expect(window.location.pathname).toBe('/chat/server-graph-id'));
      expect(lifecycle.unmounted).toHaveBeenCalledTimes(unmountsBefore);
      expect(getDetail).not.toHaveBeenCalled();
      expect(signal?.aborted).toBe(false);
      expect(wire.cancel).not.toHaveBeenCalled();
      expect(getDetail).not.toHaveBeenCalled();
    }
    await act(async () => {
      wire.push(JSON.stringify({ type: 'title_update', conversation_id: finalId, title: 'Live title' }));
      wire.push(JSON.stringify({ choices: [{ delta: { content: 'Live answer' } }] }));
    });
    expect(await screen.findByText('Live title')).toBeVisible();
    expect(await screen.findByText('Live answer')).toBeVisible();
    expect(lifecycle.mounted).toHaveBeenCalledTimes(mountsBefore);
    expect(lifecycle.unmounted).toHaveBeenCalledTimes(unmountsBefore);
    expect(signal?.aborted).toBe(false);
    expect(wire.cancel).not.toHaveBeenCalled();

    await act(async () => { wire.push('[DONE]'); });
    expect(await screen.findByText('Persisted answer')).toBeVisible();
    expect(ConversationService.updateInputConfig).toHaveBeenCalledOnce();
    expect(ConversationService.updateInputConfig).toHaveBeenCalledWith(finalId, expect.objectContaining(
      mode === 'graph' ? { selected_graph: 'graph' } : { selected_model: 'model' },
    ));
    expect(getDetail).toHaveBeenCalledOnce();
    expect(getDetail).toHaveBeenCalledWith(finalId, expect.anything());
    expect(screen.queryByText('Live answer')).not.toBeInTheDocument();
  });

  it('still unmounts the page and cancels its reader when the auth generation changes', async () => {
    const wire = stream();
    let signal: AbortSignal | undefined;
    vi.spyOn(ConversationService, 'createGraphSSE').mockImplementation(async (_request, options) => {
      signal = options?.signal;
      return wire.reader;
    });
    vi.spyOn(ConversationService, 'getConversationDetail').mockImplementation(async id => history(id, 'graph'));
    render(<StrictMode><App /></StrictMode>);
    fireEvent.click(await screen.findByRole('button', { name: 'Start graph' }));
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/chat\/.+/));
    expect(wire.cancel).not.toHaveBeenCalled();
    const unmountsBefore = lifecycle.unmounted.mock.calls.length;

    await act(async () => invalidateSession());

    expect(signal?.aborted).toBe(true);
    expect(wire.cancel).toHaveBeenCalled();
    expect(lifecycle.unmounted.mock.calls.length).toBeGreaterThan(unmountsBefore);
    expect(ConversationService.updateInputConfig).not.toHaveBeenCalled();
  });

  it.each(['temporary committed', 'server merged'] as const)('adopts the graph ID with %s navigation timing', async timing => {
    const wire = stream();
    let signal: AbortSignal | undefined;
    vi.spyOn(ConversationService, 'createGraphSSE').mockImplementation(async (_request, options) => {
      signal = options?.signal;
      return wire.reader;
    });
    const getDetail = vi.spyOn(ConversationService, 'getConversationDetail').mockImplementation(async id => history(id, 'graph'));
    render(<StrictMode><App /></StrictMode>);
    const start = await screen.findByRole('button', { name: 'Start graph' });
    const created = JSON.stringify({ type: 'conversation_created', conversation_id: 'server-graph-id' });
    if (timing === 'server merged') {
      wire.push(created);
      await act(async () => { fireEvent.click(start); });
    } else {
      fireEvent.click(start);
      await waitFor(() => expect(screen.getByTestId('committed-id')).not.toHaveTextContent('new'));
      await act(async () => { wire.push(created); });
    }
    await waitFor(() => expect(screen.getByTestId('committed-id')).toHaveTextContent('server-graph-id'));
    if (timing === 'server merged') expect(lifecycle.committedIds.filter(Boolean)).toEqual(['server-graph-id']);
    else expect(lifecycle.committedIds.filter(Boolean)).toHaveLength(2);
    expect(signal?.aborted).toBe(false);
    expect(wire.cancel).not.toHaveBeenCalled();
    expect(getDetail).not.toHaveBeenCalled();
    await act(async () => { wire.push('[DONE]'); });
    expect(await screen.findByText('Persisted answer')).toBeVisible();
    expect(getDetail).toHaveBeenCalledWith('server-graph-id', expect.anything());
  });

  it('cancels a pending graph adoption when the user chooses another conversation', async () => {
    const wire = stream();
    let signal: AbortSignal | undefined;
    vi.spyOn(ConversationService, 'createGraphSSE').mockImplementation(async (_request, options) => {
      signal = options?.signal;
      return wire.reader;
    });
    vi.spyOn(ConversationService, 'getConversationDetail').mockImplementation(async id => history(id, 'agent'));
    render(<StrictMode><App /></StrictMode>);
    fireEvent.click(await screen.findByRole('button', { name: 'Start graph' }));
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/chat\/.+/));
    await act(async () => {
      wire.push(JSON.stringify({ type: 'conversation_created', conversation_id: 'old-server-id' }));
      fireEvent.click(screen.getByRole('button', { name: 'Other conversation' }));
    });
    await waitFor(() => expect(screen.getByTestId('committed-id')).toHaveTextContent('other'));
    expect(window.location.pathname).toBe('/chat/other');
    expect(signal?.aborted).toBe(true);
    expect(wire.cancel).toHaveBeenCalled();
    expect(ConversationService.updateInputConfig).not.toHaveBeenCalled();
  });
});
