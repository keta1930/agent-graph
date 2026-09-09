import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Profiler } from 'react';
import { useConversationStore } from '../../../store/conversationStore';
import type { ConversationSummary } from '../../../types/conversation';
import ConversationItem from './ConversationItem';

vi.mock('../../../i18n/hooks', () => ({ useT: () => (key: string) => key }));
vi.mock('../../../i18n/I18nContext', () => ({ useI18n: () => ({ locale: 'en' }) }));
const initialState = useConversationStore.getState();
const notify = vi.fn<typeof initialState.showNotification>();
const titleUpdate = vi.fn<typeof initialState.updateConversationTitle>();
const tagsUpdate = vi.fn<typeof initialState.updateConversationTags>();
const permanentDelete = vi.fn<typeof initialState.deleteConversationPermanent>();
const statusUpdate = vi.fn<typeof initialState.updateConversationStatus>();
const conversation: ConversationSummary = { conversation_id: 'one', user_id: 'user', title: 'Original', status: 'active', type: 'agent', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', tags: ['original'], round_count: 1, total_token_usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 } };
function mount(status: ConversationSummary['status'] = 'active') {
  return render(<ConversationItem conversation={{ ...conversation, status }} isActive onClick={vi.fn()} />);
}
async function openMenu(container: HTMLElement, text: string) {
  const button = container.querySelector('svg.lucide-ellipsis')?.closest('button');
  expect(button).toBeTruthy();
  if (button) fireEvent.click(button);
  fireEvent.click(await screen.findByText(text));
}
beforeEach(() => {
  notify.mockReset(); titleUpdate.mockReset(); tagsUpdate.mockReset(); permanentDelete.mockReset(); statusUpdate.mockReset();
  useConversationStore.setState({ ...initialState, showNotification: notify, updateConversationTitle: titleUpdate, updateConversationTags: tagsUpdate, deleteConversationPermanent: permanentDelete, updateConversationStatus: statusUpdate });
});

describe('ConversationItem mutation failures', () => {
  it.each(['Title', 'Tags'] as const)('retains edited %s and shows one failure notification', async field => {
    const update = field === 'Title' ? titleUpdate : tagsUpdate;
    update.mockRejectedValue(new Error('Rejected'));
    const { container } = mount();
    await openMenu(container, `components.conversationItem.edit${field}`);
    const input = await screen.findByPlaceholderText(field === 'Title' ? 'components.conversationItem.titlePlaceholder' : 'components.conversationItem.tagsPlaceholder');
    fireEvent.change(input, { target: { value: 'My draft' } });
    fireEvent.click(screen.getByText('common.save'));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue('My draft');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('retains permanent-delete confirmation after failure', async () => {
    permanentDelete.mockRejectedValue(new Error('Rejected'));
    const { container } = mount('deleted');
    await openMenu(container, 'components.conversationItem.permanentDelete');
    fireEvent.click(await screen.findByText('components.conversationItem.confirmDelete'));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(notify).toHaveBeenCalledWith('components.conversationItem.deleteFailed', 'error');
  });

  it('initializes title from the latest record when reopening without erasing an open draft', async () => {
    const { container, rerender } = mount();
    rerender(<ConversationItem conversation={{ ...conversation, title: 'Server title' }} isActive onClick={vi.fn()} />);
    await openMenu(container, 'components.conversationItem.editTitle');
    const input = await screen.findByPlaceholderText('components.conversationItem.titlePlaceholder');
    expect(input).toHaveValue('Server title');
    fireEvent.change(input, { target: { value: 'Open draft' } });
    rerender(<ConversationItem conversation={{ ...conversation, title: 'Another refresh' }} isActive onClick={vi.fn()} />);
    expect(input).toHaveValue('Open draft');
  });

  it('submits an edited title at most once while saving', async () => {
    let resolve!: () => void;
    titleUpdate.mockReturnValue(new Promise<void>(accept => { resolve = accept; }));
    const { container } = mount();
    await openMenu(container, 'components.conversationItem.editTitle');
    fireEvent.change(await screen.findByPlaceholderText('components.conversationItem.titlePlaceholder'), { target: { value: 'New title' } });
    fireEvent.click(screen.getByText('common.save'));
    fireEvent.click(screen.getByText('common.save'));
    expect(titleUpdate).toHaveBeenCalledTimes(1);
    expect(titleUpdate).toHaveBeenCalledWith('one', 'New title');
    await act(async () => resolve());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not commit again for an unrelated store error update', () => {
    const onRender = vi.fn();
    render(<Profiler id="item" onRender={onRender}><ConversationItem conversation={conversation} isActive onClick={vi.fn()} /></Profiler>);
    onRender.mockClear();
    act(() => useConversationStore.setState({ error: 'An unrelated request failed' }));
    expect(onRender).not.toHaveBeenCalled();
  });
});
