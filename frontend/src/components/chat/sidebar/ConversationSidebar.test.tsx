import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '../../../types/conversation';
import { useConversationStore } from '../../../store/conversationStore';
import ConversationSidebar from './ConversationSidebar';

vi.mock('../../../i18n/hooks', () => ({ useT: () => (key: string, params?: { count?: number }) => params?.count === undefined ? key : `${key}:${params.count}` }));
vi.mock('../../../i18n/I18nContext', () => ({ useI18n: () => ({ locale: 'en' }) }));
vi.mock('../../common/UserMenu', () => ({ default: () => null }));
vi.mock('../modal/ExportManagerButton', () => ({ default: () => null }));

const initialState = useConversationStore.getState();
const batchDelete = vi.fn<typeof initialState.batchDeleteConversations>();
const refresh = vi.fn<typeof initialState.silentUpdateConversations>();
const notify = vi.fn<typeof initialState.showNotification>();
const statusUpdate = vi.fn<typeof initialState.updateConversationStatus>();
const permanentDelete = vi.fn<typeof initialState.deleteConversationPermanent>();
const conversation = (id: string, status: ConversationSummary['status'] = 'active'): ConversationSummary => ({
  conversation_id: id, user_id: 'user', title: id, status, type: 'agent', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', tags: [], round_count: 1,
  total_token_usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
});
const fixture = [conversation('active-ok'), conversation('active-fail'), conversation('deleted-ok', 'deleted'), conversation('deleted-fail', 'deleted')];
function mount(activeConversationId = 'active-ok', onNewConversation = vi.fn()) {
  return { onNewConversation, ...render(<MemoryRouter><ConversationSidebar activeConversationId={activeConversationId} onConversationSelect={vi.fn()} onNewConversation={onNewConversation} /></MemoryRouter>) };
}
function enterBatch(container: HTMLElement) {
  const button = container.querySelector('svg.lucide-square-check-big')?.closest('button');
  expect(button).toBeTruthy();
  if (button) fireEvent.click(button);
}
function checkedIds() {
  return screen.getAllByRole<HTMLInputElement>('checkbox').filter(input => input.checked).map(input => input.closest('.conversation-item-checkbox')?.parentElement?.children[1]?.textContent);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

beforeEach(() => {
  batchDelete.mockReset(); refresh.mockReset().mockResolvedValue(undefined); notify.mockReset();
  statusUpdate.mockReset().mockResolvedValue(undefined); permanentDelete.mockReset().mockResolvedValue(undefined);
  useConversationStore.setState({ ...initialState, conversations: fixture, searchQuery: '', loading: false, sidebarCollapsed: false,
    loadConversations: vi.fn().mockResolvedValue(undefined), silentUpdateConversations: refresh, batchDeleteConversations: batchDelete,
    showNotification: notify, updateConversationStatus: statusUpdate, deleteConversationPermanent: permanentDelete,
  });
});
afterEach(() => { vi.useRealTimers(); });

it('pauses hidden polling, refreshes once on resume, and cleans up the visibility listener and timer', async () => {
  vi.useFakeTimers();
  let hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  const { unmount } = mount();
  expect(useConversationStore.getState().loadConversations).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(refresh).toHaveBeenCalledTimes(1);
  hidden = true;
  fireEvent(document, new Event('visibilitychange'));
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(refresh).toHaveBeenCalledTimes(1);
  hidden = false;
  fireEvent(document, new Event('visibilitychange'));
  fireEvent(document, new Event('visibilitychange'));
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(14999));
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(refresh).toHaveBeenCalledTimes(3);
  unmount();
  hidden = true;
  fireEvent(document, new Event('visibilitychange'));
  hidden = false;
  fireEvent(document, new Event('visibilitychange'));
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(refresh).toHaveBeenCalledTimes(3);
});

it('does not start polling while initially hidden', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  const { unmount } = mount();
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(refresh).not.toHaveBeenCalled();
  expect(useConversationStore.getState().loadConversations).toHaveBeenCalledTimes(1);
  unmount();
});

describe('ConversationSidebar deletion', () => {
  it('aggregates mixed partial failures once and retains only failed selections', async () => {
    batchDelete.mockResolvedValueOnce({ succeededIds: ['active-ok'], failed: [{ id: 'active-fail', message: 'Denied' }] })
      .mockResolvedValueOnce({ succeededIds: ['deleted-ok'], failed: [{ id: 'deleted-fail', message: 'Denied' }] });
    const { container, onNewConversation } = mount();
    enterBatch(container);
    fireEvent.click(screen.getByText('components.conversationSidebar.selectAll'));
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(batchDelete.mock.calls).toEqual([
      [['active-ok', 'active-fail'], false, { refresh: false }],
      [['deleted-ok', 'deleted-fail'], true, { refresh: false }],
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(checkedIds()).toEqual(['active-fail', 'deleted-fail']);
    expect(screen.getByText('components.conversationSidebar.selectedCount:2')).toBeInTheDocument();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('softDeleteFailed:1'), 'error');
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  it('keeps all failed selections without refreshing or clearing the active conversation', async () => {
    batchDelete.mockImplementation(async ids => ({ succeededIds: [], failed: ids.map(id => ({ id, message: 'Denied' })) }));
    const { container, onNewConversation } = mount();
    enterBatch(container);
    fireEvent.click(screen.getByText('components.conversationSidebar.selectAll'));
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(refresh).not.toHaveBeenCalled();
    expect(checkedIds()).toEqual(fixture.map(item => item.conversation_id));
    expect(onNewConversation).not.toHaveBeenCalled();
  });

  it('preserves a successful first group when the next group rejects', async () => {
    batchDelete.mockResolvedValueOnce({ succeededIds: ['active-ok', 'active-fail'], failed: [] }).mockRejectedValueOnce(new Error('Transport failure'));
    const { container, onNewConversation } = mount();
    enterBatch(container);
    fireEvent.click(screen.getByText('components.conversationSidebar.selectAll'));
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(checkedIds()).toEqual(['deleted-ok', 'deleted-fail']);
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  it('checks visible selection membership instead of comparing collection lengths', () => {
    const { container } = mount();
    enterBatch(container);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    act(() => useConversationStore.setState({ searchQuery: 'deleted-' }));
    const selectAll = screen.getByText('components.conversationSidebar.selectAll').closest('button');
    expect(selectAll).not.toBeDisabled();
    if (selectAll) fireEvent.click(selectAll);
    expect(checkedIds()).toEqual(['deleted-ok', 'deleted-fail']);
  });

  it('excludes disappeared IDs from selected count and deletion payload', async () => {
    batchDelete.mockImplementation(async ids => ({ succeededIds: ids, failed: [] }));
    const { container } = mount('unrelated');
    enterBatch(container);
    fireEvent.click(screen.getByText('components.conversationSidebar.selectAll'));
    act(() => useConversationStore.setState({ conversations: fixture.slice(1) }));
    expect(screen.getByText('components.conversationSidebar.selectedCount:3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(batchDelete.mock.calls.flatMap(([ids]) => ids)).toEqual(['active-fail', 'deleted-ok', 'deleted-fail']);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('does not clear a newer active conversation after a pending batch completes', async () => {
    const pending = deferred<Awaited<ReturnType<typeof batchDelete>>>();
    batchDelete.mockReturnValue(pending.promise);
    const { container, rerender, onNewConversation } = mount();
    enterBatch(container);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    rerender(<MemoryRouter><ConversationSidebar activeConversationId="new-current" onConversationSelect={vi.fn()} onNewConversation={onNewConversation} /></MemoryRouter>);
    await act(async () => pending.resolve({ succeededIds: ['active-ok'], failed: [] }));
    expect(onNewConversation).not.toHaveBeenCalled();
  });

  it.each(['active', 'deleted'] as const)('clears URL through onNewConversation only after successful single %s deletion', async status => {
    useConversationStore.setState({ conversations: [conversation('target', status)] });
    const { container, onNewConversation } = mount('target');
    const menu = container.querySelector('svg.lucide-ellipsis')?.closest('button');
    expect(menu).toBeTruthy();
    if (menu) fireEvent.click(menu);
    fireEvent.click(await screen.findByText(status === 'deleted' ? 'components.conversationItem.permanentDelete' : 'common.delete'));
    if (status === 'deleted') fireEvent.click(await screen.findByText('components.conversationItem.confirmDelete'));
    await waitFor(() => expect(onNewConversation).toHaveBeenCalledTimes(1));
  });

  it('does not navigate after a single deletion fails', async () => {
    statusUpdate.mockRejectedValue(new Error('Denied'));
    useConversationStore.setState({ conversations: [conversation('target')] });
    const { container, onNewConversation } = mount('target');
    const menu = container.querySelector('svg.lucide-ellipsis')?.closest('button');
    if (menu) fireEvent.click(menu);
    fireEvent.click(await screen.findByText('common.delete'));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(onNewConversation).not.toHaveBeenCalled();
    expect(screen.getByText('target')).toBeInTheDocument();
    expect(notify).toHaveBeenCalledWith('components.conversationItem.deleteFailed', 'error');
  });

  it('does not clear a newer current conversation when a single deletion resolves', async () => {
    const pending = deferred<void>();
    statusUpdate.mockReturnValue(pending.promise);
    useConversationStore.setState({ conversations: [conversation('target')] });
    const { container, rerender, onNewConversation } = mount('target');
    const menu = container.querySelector('svg.lucide-ellipsis')?.closest('button');
    if (menu) fireEvent.click(menu);
    fireEvent.click(await screen.findByText('common.delete'));
    rerender(<MemoryRouter><ConversationSidebar activeConversationId="new-current" onConversationSelect={vi.fn()} onNewConversation={onNewConversation} /></MemoryRouter>);
    await act(async () => pending.resolve());
    expect(onNewConversation).not.toHaveBeenCalled();
  });

  it('still clears the current URL if permanent deletion removes the Item before its refresh resolves', async () => {
    const pending = deferred<void>();
    permanentDelete.mockImplementation(() => {
      useConversationStore.setState({ conversations: [] });
      return pending.promise;
    });
    useConversationStore.setState({ conversations: [conversation('target', 'deleted')] });
    const { container, onNewConversation } = mount('target');
    const menu = container.querySelector('svg.lucide-ellipsis')?.closest('button');
    if (menu) fireEvent.click(menu);
    fireEvent.click(await screen.findByText('components.conversationItem.permanentDelete'));
    fireEvent.click(await screen.findByText('components.conversationItem.confirmDelete'));
    expect(screen.queryByText('target')).not.toBeInTheDocument();
    expect(onNewConversation).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  it('keeps deletion success and navigation when the single list refresh fails', async () => {
    batchDelete.mockResolvedValue({ succeededIds: ['active-ok'], failed: [] });
    refresh.mockRejectedValue(new Error('List refresh failed'));
    const { container, onNewConversation } = mount();
    enterBatch(container);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('movedToTrash:1'), 'error');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('List refresh failed'), 'error');
  });
});
