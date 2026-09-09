import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import FileViewModal from './FileViewModal';
import type { FileDetailResponse } from '../../types/conversationFile';

vi.mock('../../i18n/hooks', () => { const t = (key: string) => key; return { useT: () => t }; });
vi.mock('./FileEditor', () => ({ default: ({ content, onChange, onSave, isDirty }: { content: string; onChange: (value: string) => void; onSave: () => void; isDirty: boolean }) => <div><textarea aria-label="content" value={content} onChange={event => onChange(event.target.value)} /><button onClick={onSave}>save editor</button><span>{isDirty ? 'dirty' : 'clean'}</span></div> }));
vi.mock('./FileVersionHistory', () => ({ default: () => null }));
vi.mock('./MarkdownPreview', () => ({ default: () => null }));
vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return { ...actual, Modal: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null, App: { useApp: () => ({ modal: { confirm: vi.fn() } }) }, message: { error: vi.fn(), success: vi.fn() } };
});
function detail(content: string): FileDetailResponse {
  return { success: true, file: { filename: 'file.txt', content, summary: '', versions: [], current_version_id: '1' } };
}

it('ignores a late file response after switching or closing, and aborts the previous request', async () => {
  let finish!: (value: FileDetailResponse) => void;
  const getFile = vi.fn().mockImplementationOnce(() => new Promise<FileDetailResponse>(resolve => { finish = resolve; })).mockResolvedValue(detail('B content'));
  const service = { getFile, updateFile: vi.fn(), deleteFile: vi.fn(), getFileVersion: vi.fn() };
  const props = { visible: true, resourceId: 'conversation', onClose: vi.fn(), fileService: service };
  const { rerender } = render(<FileViewModal {...props} filename="A.txt" />);
  await waitFor(() => expect(getFile).toHaveBeenCalledTimes(1));
  const signal = getFile.mock.calls[0][2].signal;
  rerender(<FileViewModal {...props} filename="B.txt" />);
  await waitFor(() => expect(screen.getByLabelText('content')).toHaveValue('B content'));
  expect(signal.aborted).toBe(true);
  await act(async () => finish(detail('A late')));
  expect(screen.getByLabelText('content')).toHaveValue('B content');
  rerender(<FileViewModal {...props} filename="B.txt" visible={false} />);
  expect(screen.queryByLabelText('content')).not.toBeInTheDocument();
});

it('preserves edits made while a save is pending', async () => {
  let finish!: () => void;
  const service = { getFile: vi.fn().mockResolvedValue(detail('original')), updateFile: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), deleteFile: vi.fn(), getFileVersion: vi.fn() };
  const fileService = { ...service, updateFile: vi.fn(async () => { await service.updateFile(); return { success: true, message: 'saved' }; }) };
  render(<FileViewModal visible resourceId="conversation" filename="file.txt" onClose={vi.fn()} fileService={fileService} />);
  await waitFor(() => expect(screen.getByLabelText('content')).toHaveValue('original'));
  fireEvent.change(screen.getByLabelText('content'), { target: { value: 'saved snapshot' } });
  fireEvent.click(screen.getByText('save editor'));
  fireEvent.change(screen.getByLabelText('content'), { target: { value: 'new edit' } });
  await act(async () => finish());
  expect(screen.getByLabelText('content')).toHaveValue('new edit');
  expect(screen.getByText('dirty')).toBeInTheDocument();
});
