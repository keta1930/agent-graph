import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import ExportManager from './ExportManager';
import api from '../services/api';
import exportService from '../services/exportService';
import type { ConversationSummary } from '../types/conversation';

vi.mock('../i18n/hooks', () => { const t = (key: string, values?: { count?: number }) => values?.count === undefined ? key : `${key}:${values.count}`; return { useT: () => t }; });
vi.mock('../components/chat/modal/RawPreviewModal', () => ({ default: () => null }));

it('selects and exports all 201 IDs, finds the final page keyword, and keeps filters after a failed refresh', async () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }) });
  const conversations: ConversationSummary[] = Array.from({ length: 201 }, (_, index) => ({
    conversation_id: `${index}`, title: index === 200 ? 'last-only-keyword' : `Conversation ${index}`, user_id: 'user', type: 'agent', status: 'active', tags: [],
    created_at: '2026-01-01', updated_at: '', round_count: 0, total_token_usage: { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 },
  }));
  let fail = false;
  vi.spyOn(api, 'get').mockImplementation(async (_url, config) => {
    const skip = config?.params.skip as number;
    if (skip === 200 && fail) throw new Error('middle page failed');
    return { data: { conversations: conversations.slice(skip, skip + 200), total_count: 201 } };
  });
  vi.spyOn(exportService, 'listDatasets').mockResolvedValue({ success: true, exports: [] });
  const exported = vi.spyOn(exportService, 'exportConversations').mockResolvedValue({ success: false, message: 'fixture export' });
  render(<MemoryRouter><ExportManager /></MemoryRouter>);
  await screen.findByText('last-only-keyword');
  fireEvent.click(screen.getByText('pages.exportManager.selectAll'));
  expect(screen.getByText('pages.exportManager.selected:201')).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('pages.exportManager.searchPlaceholder'), { target: { value: 'last-only-keyword' } });
  expect(screen.queryByText('Conversation 0')).not.toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('pages.exportManager.datasetNamePlaceholder'), { target: { value: 'dataset' } });
  fireEvent.change(screen.getByPlaceholderText('pages.exportManager.fileNamePlaceholder'), { target: { value: 'complete' } });
  fireEvent.click(screen.getByRole('button', { name: 'pages.exportManager.confirmExport' }));
  await waitFor(() => expect(exported).toHaveBeenCalledOnce());
  expect(exported.mock.calls[0][0].conversation_ids).toEqual(conversations.map(item => item.conversation_id));
  fail = true;
  fireEvent.click(screen.getByRole('button', { name: 'pages.exportManager.refresh' }));
  await screen.findByText('middle page failed');
  expect(screen.getByPlaceholderText('pages.exportManager.searchPlaceholder')).toHaveValue('last-only-keyword');
  expect(screen.getByText('last-only-keyword')).toBeInTheDocument();
  expect(screen.getByText('pages.exportManager.selected:201')).toBeInTheDocument();
}, 15000);
