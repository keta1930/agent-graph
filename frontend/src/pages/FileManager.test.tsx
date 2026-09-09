import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import FileManager from './FileManager';
import { ConversationService } from '../services/conversationService';
import conversationFileService from '../services/conversationFileService';
import type { ConversationSummary } from '../types/conversation';

const messages = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('../i18n/hooks', () => { const t = (key: string) => key; return { useT: () => t }; });
vi.mock('../components/conversation-file/FileViewModal', () => ({ default: () => null }));
vi.mock('antd', async importOriginal => {
  const original = await importOriginal<typeof import('antd')>();
  return { ...original, App: { ...original.App, useApp: () => ({ message: messages }) } };
});
const conversations = (total: number): ConversationSummary[] => Array.from({ length: total }, (_, index) => ({
  conversation_id: `${index}`, title: `Conversation ${index}`, user_id: 'user', type: 'agent', status: 'active', tags: [],
  created_at: '', updated_at: '', round_count: 0, total_token_usage: { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 },
}));
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }) });
});

it('visits all 201 conversations with at most four requests and can find the final file', async () => {
  vi.spyOn(ConversationService, 'getConversations').mockResolvedValue({ conversations: conversations(201), total_count: 201 });
  let active = 0, maximum = 0;
  const release: (() => void)[] = [];
  const list = vi.spyOn(conversationFileService, 'listFiles').mockImplementation(async id => {
    active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => release.push(resolve));
    active--;
    return { success: true, conversation_id: id, files: id === '200' ? ['last-only-keyword.txt'] : [], total_count: id === '200' ? 1 : 0 };
  });
  render(<FileManager />);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
  while (list.mock.calls.length < 201 || active > 0) {
    await act(async () => { release.splice(0).forEach(resolve => resolve()); });
  }
  expect(maximum).toBe(4);
  expect(list).toHaveBeenCalledTimes(201);
  fireEvent.change(screen.getByPlaceholderText('pages.fileManager.searchPlaceholder'), { target: { value: 'last-only-keyword' } });
  fireEvent.click(await screen.findByText('Conversation 200'));
  expect(await screen.findByText('last-only-keyword.txt')).toBeInTheDocument();
});

it('cancels active file reads on unmount and does not start queued work', async () => {
  vi.spyOn(ConversationService, 'getConversations').mockResolvedValue({ conversations: conversations(8), total_count: 8 });
  const release: (() => void)[] = [];
  const signals: AbortSignal[] = [];
  const list = vi.spyOn(conversationFileService, 'listFiles').mockImplementation(async (id, options) => {
    signals.push(options!.signal!);
    await new Promise<void>(resolve => release.push(resolve));
    return { success: true, conversation_id: id, files: [], total_count: 0 };
  });
  const { unmount } = render(<FileManager />);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
  unmount();
  expect(signals.every(signal => signal.aborted)).toBe(true);
  await act(async () => release.forEach(resolve => resolve()));
  expect(list).toHaveBeenCalledTimes(4);
  expect(messages.error).not.toHaveBeenCalled();
});

it('reports a failed file page without showing a successful partial list', async () => {
  vi.spyOn(ConversationService, 'getConversations').mockResolvedValue({ conversations: conversations(5), total_count: 5 });
  const list = vi.spyOn(conversationFileService, 'listFiles').mockImplementation(async id => {
    if (id === '1') throw new Error('storage unavailable');
    return { success: true, conversation_id: id, files: ['partial.txt'], total_count: 1 };
  });
  render(<FileManager />);
  await waitFor(() => expect(messages.error).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('Conversation 0')).not.toBeInTheDocument();
  expect(list.mock.calls[0][1]?.signal?.aborted).toBe(true);
});
