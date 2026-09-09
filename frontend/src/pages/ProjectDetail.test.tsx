import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { App, ConfigProvider } from 'antd';
import ProjectDetail from './ProjectDetail';
const mocks = vi.hoisted(() => ({ getProjectDetail: vi.fn(), uploadFile: vi.fn(), createFile: vi.fn(), getConversations: vi.fn(), listFiles: vi.fn(), projectListFiles: vi.fn(), deleteFile: vi.fn(), pushFile: vi.fn() }));
vi.mock('../i18n/hooks', () => { const t = (key: string) => key; return { useT: () => t }; });
vi.mock('../i18n/I18nContext', () => ({ useI18n: () => ({ locale: 'en' }) }));
vi.mock('../services/projectService', () => ({ projectService: { getProjectDetail: mocks.getProjectDetail } }));
vi.mock('../services/projectFileService', () => ({ default: { uploadFile: mocks.uploadFile, createFile: mocks.createFile, pushFileFromConversation: mocks.pushFile, listFiles: mocks.projectListFiles, deleteFile: mocks.deleteFile } }));
vi.mock('../components/conversation-file/FileViewModal', () => ({ default: ({ visible, onSave }: { visible: boolean; onSave: () => void }) => visible ? <button onClick={onSave}>refresh open file</button> : null }));
vi.mock('../services/conversationService', () => ({ ConversationService: { getConversations: mocks.getConversations } }));
vi.mock('../services/conversationFileService', () => ({ default: { listFiles: mocks.listFiles } }));
function fileList(id: string, files: string[]) { return { success: true, project_id: id, total_count: files.length, files }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function Controls() { const navigate = useNavigate(); return <><button onClick={() => navigate('/projects/A')}>switch A</button><button onClick={() => navigate('/projects/B')}>switch B</button></>; }
function mountProject(id = 'A') { return render(<MemoryRouter initialEntries={['/projects/' + id]}><ConfigProvider theme={{ token: { motion: false } }}><App><Controls /><Routes><Route path="/projects/:projectId" element={<ProjectDetail />} /></Routes></App></ConfigProvider></MemoryRouter>); }
async function selectSource(id: 'A' | 'B') {
  fireEvent.mouseDown(document.getElementById('conversationId')!);
  fireEvent.click(await screen.findByText('Source ' + id, { selector: '.ant-select-item-option-content' }));
}
async function selectFile(name: string) {
  fireEvent.mouseDown(document.getElementById('filename')!);
  fireEvent.click(await screen.findByText(name, { selector: '.ant-select-item-option-content' }));
}
function modalButton(label: 'common.create' | 'common.confirm') {
  const button = screen.getByText(label).closest('button');
  if (!button) throw new Error('Missing dialog button: ' + label);
  return button;
}
beforeEach(() => {
  const getComputedStyle = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element));
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} })));
  mocks.getProjectDetail.mockImplementation(async (id: string) => ({ project_id: id, name: 'Project ' + id, instruction: '', files: null, conversations: [], conversation_count: 0 }));
  mocks.projectListFiles.mockImplementation(async (id: string) => fileList(id, [id + '.txt']));
  mocks.uploadFile.mockResolvedValue({ success: true });
  mocks.createFile.mockResolvedValue({ success: true });
  mocks.deleteFile.mockResolvedValue({ success: true });
  mocks.getConversations.mockResolvedValue({ conversations: [{ conversation_id: 'A', title: 'Source A' }, { conversation_id: 'B', title: 'Source B' }], total_count: 2 });
  mocks.listFiles.mockImplementation(async (id: string) => ({ files: [id + '-only.txt'] }));
  mocks.pushFile.mockResolvedValue({ success: true });
}, 15000);
it.each([['A', 'B'], ['B', 'A']])('starts %s → %s with a visible file list while the previous upload is still pending', async (from, to) => {
  const upload = deferred<void>(); mocks.uploadFile.mockReturnValue(upload.promise);
  const view = mountProject(from); await screen.findByText(from + '.txt');
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(['a'], 'upload.txt')] } });
  await waitFor(() => expect(mocks.uploadFile).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText('switch ' + to));
  await screen.findByText('Project ' + to);
  expect(await screen.findByText(to + '.txt')).toBeInTheDocument();
  await act(async () => upload.resolve());
  expect(screen.getByText(to + '.txt')).toBeInTheDocument();
}, 15000);
it('does not let the old upload finally clear B upload loading', async () => {
  const a = deferred<void>(), b = deferred<void>();
  mocks.uploadFile.mockImplementation((id: string) => id === 'A' ? a.promise : b.promise);
  const view = mountProject(); await screen.findByText('A.txt');
  const upload = () => fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(['a'], 'upload.txt')] } });
  upload(); await waitFor(() => expect(mocks.uploadFile).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText('switch B')); await screen.findByText('Project B');
  upload(); await waitFor(() => expect(mocks.uploadFile).toHaveBeenCalledTimes(2));
  await act(async () => a.resolve());
  expect(view.container.querySelector('.ant-spin-spinning')).not.toBeNull();
  expect(screen.queryByText('B.txt')).toBeNull();
  await act(async () => b.resolve());
  expect(await screen.findByText('B.txt')).toBeInTheDocument();
}, 15000);
it('resets pending create state and prevents the old finally from clearing a new project submission', async () => {
  const pending = deferred<void>(), current = deferred<void>();
  mocks.createFile.mockImplementation((id: string) => id === 'A' ? pending.promise : current.promise);
  mountProject(); await screen.findByText('A.txt');
  fireEvent.click(screen.getByText('pages.projectDetail.newFile'));
  fireEvent.change(screen.getByPlaceholderText('pages.projectDetail.fileNamePlaceholder'), { target: { value: 'created.txt' } });
  fireEvent.click(modalButton('common.create'));
  await waitFor(() => expect(mocks.createFile).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText('switch B')); await screen.findByText('Project B');
  fireEvent.click(screen.getByText('pages.projectDetail.newFile'));
  expect(modalButton('common.create')).not.toHaveClass('ant-btn-loading');
  fireEvent.change(screen.getByPlaceholderText('pages.projectDetail.fileNamePlaceholder'), { target: { value: 'B-created.txt' } });
  fireEvent.click(modalButton('common.create'));
  await waitFor(() => expect(mocks.createFile).toHaveBeenCalledWith('B', expect.objectContaining({ filename: 'B-created.txt' })));
  await act(async () => pending.resolve());
  expect(modalButton('common.create')).toHaveClass('ant-btn-loading');
  expect(screen.getByPlaceholderText('pages.projectDetail.fileNamePlaceholder')).toHaveValue('B-created.txt');
  await act(async () => current.resolve());
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}, 15000);
it('resets pending push state and prevents the old finally from clearing a new project submission', async () => {
  const pending = deferred<void>(), current = deferred<void>();
  mocks.pushFile.mockImplementation((id: string) => id === 'A' ? pending.promise : current.promise);
  mountProject(); await screen.findByText('A.txt');
  fireEvent.click(screen.getByText('pages.projectDetail.pushFile'));
  await selectSource('A'); await selectFile('A-only.txt');
  fireEvent.click(modalButton('common.confirm'));
  await waitFor(() => expect(mocks.pushFile).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText('switch B')); await screen.findByText('Project B');
  fireEvent.click(screen.getByText('pages.projectDetail.pushFile'));
  expect(modalButton('common.confirm')).not.toHaveClass('ant-btn-loading');
  await selectSource('B'); await selectFile('B-only.txt');
  fireEvent.click(modalButton('common.confirm'));
  await waitFor(() => expect(mocks.pushFile).toHaveBeenCalledWith('B', { conversation_id: 'B', filename: 'B-only.txt' }));
  await act(async () => pending.resolve());
  expect(modalButton('common.confirm')).toHaveClass('ant-btn-loading');
  await act(async () => current.resolve());
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}, 15000);
it.each(['B-only.txt', 'A-only.txt'])('requires a new selection after switching source even when its filename is %s', async filename => {
  const b = deferred<{ files: string[] }>();
  mocks.listFiles.mockImplementation((id: string) => id === 'A' ? Promise.resolve({ files: ['A-only.txt'] }) : b.promise);
  mountProject(); await screen.findByText('A.txt');
  fireEvent.click(screen.getByText('pages.projectDetail.pushFile'));
  await selectSource('A'); await selectFile('A-only.txt');
  await selectSource('B');
  await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledWith('B'));
  expect(document.querySelector('#filename')?.closest('.ant-select')).not.toHaveTextContent('A-only.txt');
  expect(modalButton('common.confirm')).toBeDisabled();
  fireEvent.click(modalButton('common.confirm'));
  expect(mocks.pushFile).not.toHaveBeenCalled();
  await act(async () => b.resolve({ files: [filename] }));
  fireEvent.click(modalButton('common.confirm'));
  await screen.findByText('pages.projectDetail.selectFileRequired');
  expect(mocks.pushFile).not.toHaveBeenCalled();
  await selectFile(filename);
  fireEvent.click(modalButton('common.confirm'));
  await waitFor(() => expect(mocks.pushFile).toHaveBeenCalledWith('A', { conversation_id: 'B', filename }));
}, 15000);
it('ignores an old source list after switching source and keeps failed new reads unselectable', async () => {
  const a = deferred<{ files: string[] }>();
  mocks.listFiles.mockImplementation((id: string) => id === 'A' ? a.promise : Promise.reject(new Error('B unavailable')));
  mountProject(); await screen.findByText('A.txt');
  fireEvent.click(screen.getByText('pages.projectDetail.pushFile'));
  await selectSource('A'); await selectSource('B');
  await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledWith('B'));
  await act(async () => a.resolve({ files: ['A-only.txt'] }));
  expect(modalButton('common.confirm')).toBeDisabled();
  expect(document.querySelector('#filename')?.closest('.ant-select')).not.toHaveTextContent('A-only.txt');
}, 15000);
it('keeps a previously selected filename cleared after the new source fails', async () => {
  mocks.listFiles.mockImplementation((id: string) => id === 'A'
    ? Promise.resolve({ files: ['A-only.txt'] })
    : Promise.reject(new Error('B unavailable')));
  mountProject(); await screen.findByText('A.txt');
  fireEvent.click(screen.getByText('pages.projectDetail.pushFile'));
  await selectSource('A'); await selectFile('A-only.txt');
  await selectSource('B');
  await screen.findByText('pages.projectDetail.fileLoadConversationFailed');
  expect(document.querySelector('#filename')?.closest('.ant-select')).not.toHaveTextContent('A-only.txt');
  expect(modalButton('common.confirm')).toBeDisabled();
  fireEvent.click(modalButton('common.confirm'));
  expect(mocks.pushFile).not.toHaveBeenCalled();
}, 15000);
it('keeps the new source loading when the previous source finally completes', async () => {
  const a = deferred<{ files: string[] }>(), b = deferred<{ files: string[] }>();
  mocks.listFiles.mockImplementation((id: string) => id === 'A' ? a.promise : b.promise);
  mountProject(); await screen.findByText('A.txt');
  fireEvent.click(screen.getByText('pages.projectDetail.pushFile'));
  await selectSource('A'); await selectSource('B');
  await act(async () => a.resolve({ files: ['A-only.txt'] }));
  expect(document.querySelector('#filename')?.closest('.ant-select')).toHaveClass('ant-select-loading');
  expect(modalButton('common.confirm')).toBeDisabled();
  await act(async () => b.resolve({ files: ['B-only.txt'] }));
  expect(document.querySelector('#filename')?.closest('.ant-select')).not.toHaveClass('ant-select-loading');
  await selectFile('B-only.txt');
  fireEvent.click(modalButton('common.confirm'));
  await waitFor(() => expect(mocks.pushFile).toHaveBeenCalledWith('A', { conversation_id: 'B', filename: 'B-only.txt' }));
}, 15000);
it('resets source loading across projects and rejects a late read after returning to the same project', async () => {
  const old = deferred<{ files: string[] }>(), current = deferred<{ files: string[] }>();
  mocks.listFiles.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  mountProject(); await screen.findByText('A.txt');
  fireEvent.click(screen.getByText('pages.projectDetail.pushFile'));
  await selectSource('A');
  expect(document.querySelector('#filename')?.closest('.ant-select')).toHaveClass('ant-select-loading');
  fireEvent.click(screen.getByText('switch B')); await screen.findByText('B.txt');
  fireEvent.click(screen.getByText('pages.projectDetail.pushFile'));
  expect(document.querySelector('#filename')?.closest('.ant-select')).not.toHaveClass('ant-select-loading');
  fireEvent.click(screen.getByText('switch A')); await screen.findByText('A.txt');
  fireEvent.click(screen.getByText('pages.projectDetail.pushFile'));
  await selectSource('A');
  await act(async () => old.resolve({ files: ['stale.txt'] }));
  expect(document.querySelector('#filename')?.closest('.ant-select')).toHaveClass('ant-select-loading');
  expect(modalButton('common.confirm')).toBeDisabled();
  await act(async () => current.resolve({ files: ['current.txt'] }));
  await selectFile('current.txt');
  expect(screen.queryByText('stale.txt')).toBeNull();
}, 15000);
it('keeps the new project conversation list loading when the old project request completes', async () => {
  const old = deferred<{ conversations: { conversation_id: string; title: string }[] }>();
  const current = deferred<{ conversations: { conversation_id: string; title: string }[] }>();
  mocks.getConversations.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  mountProject(); await screen.findByText('A.txt');
  fireEvent.click(screen.getByText('pages.projectDetail.addConversation'));
  await waitFor(() => expect(mocks.getConversations).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText('switch B')); await screen.findByText('B.txt');
  fireEvent.click(screen.getByText('pages.projectDetail.addConversation'));
  await waitFor(() => expect(mocks.getConversations).toHaveBeenCalledTimes(2));
  await act(async () => old.resolve({ conversations: [{ conversation_id: 'old', title: 'Old conversation' }] }));
  expect(screen.getByRole('dialog').querySelector('.ant-spin-spinning')).not.toBeNull();
  expect(screen.queryByText('Old conversation')).toBeNull();
  await act(async () => current.resolve({ conversations: [{ conversation_id: 'new', title: 'New conversation' }] }));
  expect(await screen.findByText('New conversation')).toBeInTheDocument();
  expect(screen.getByRole('dialog').querySelector('.ant-spin-spinning')).toBeNull();
}, 15000);

it('loads real file-list response while the project detail has files:null', async () => {
  mountProject();
  expect(await screen.findByText('A.txt')).toBeInTheDocument();
  expect(mocks.projectListFiles).toHaveBeenCalledWith('A', { signal: expect.any(AbortSignal) });
  expect(mocks.getProjectDetail).toHaveBeenCalledOnce();
});

it('refreshes the dedicated file list after creating and deleting a file', async () => {
  mountProject(); await screen.findByText('A.txt');
  mocks.projectListFiles.mockResolvedValue(fileList('A', ['A.txt', 'created.txt']));
  fireEvent.click(screen.getByText('pages.projectDetail.newFile'));
  fireEvent.change(screen.getByPlaceholderText('pages.projectDetail.fileNamePlaceholder'), { target: { value: 'created.txt' } });
  fireEvent.click(modalButton('common.create'));
  const created = await screen.findByText('created.txt');
  expect(mocks.createFile).toHaveBeenCalledWith('A', expect.objectContaining({ filename: 'created.txt' }));
  mocks.projectListFiles.mockResolvedValue(fileList('A', ['A.txt']));
  fireEvent.click(within(created.closest('.ant-list-item') as HTMLElement).getByText('common.delete'));
  await screen.findByText('pages.projectDetail.fileDeleteConfirmTitle');
  fireEvent.click(document.querySelector('.ant-popconfirm-buttons .ant-btn-primary')!);
  await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalledWith('A', 'created.txt'));
  await waitFor(() => expect(screen.queryByText('created.txt')).toBeNull());
  expect(screen.getByText('A.txt')).toBeInTheDocument();
  expect(mocks.projectListFiles).toHaveBeenCalledTimes(3);
});

it('aborts old project file reads and rejects a late result after A → B → A', async () => {
  const old = deferred<ReturnType<typeof fileList>>(), current = deferred<ReturnType<typeof fileList>>();
  mocks.projectListFiles.mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(fileList('B', ['B.txt'])).mockReturnValueOnce(current.promise);
  const view = mountProject(); await screen.findByText('Project A');
  const oldSignal = mocks.projectListFiles.mock.calls[0][1].signal as AbortSignal;
  fireEvent.click(screen.getByText('switch B')); await screen.findByText('B.txt');
  expect(oldSignal.aborted).toBe(true);
  fireEvent.click(screen.getByText('switch A')); await screen.findByText('Project A');
  await act(async () => old.resolve(fileList('A', ['stale.txt'])));
  expect(screen.queryByText('stale.txt')).toBeNull();
  expect(view.container.querySelector('.ant-spin-spinning')).not.toBeNull();
  await act(async () => current.resolve(fileList('A', ['current.txt'])));
  expect(await screen.findByText('current.txt')).toBeInTheDocument();
  expect(screen.queryByText('B.txt')).toBeNull();
});

it('keeps the newest same-project file refresh pending when the older refresh resolves', async () => {
  const old = deferred<ReturnType<typeof fileList>>(), current = deferred<ReturnType<typeof fileList>>();
  const view = mountProject(); await screen.findByText('A.txt');
  fireEvent.click(screen.getByText('pages.projectDetail.openFile'));
  mocks.projectListFiles.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  fireEvent.click(screen.getByText('refresh open file'));
  const oldSignal = mocks.projectListFiles.mock.calls[1][1].signal as AbortSignal;
  fireEvent.click(screen.getByText('refresh open file'));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => old.resolve(fileList('A', ['stale.txt'])));
  expect(view.container.querySelector('.ant-spin-spinning')).not.toBeNull();
  expect(screen.queryByText('stale.txt')).toBeNull();
  await act(async () => current.resolve(fileList('A', ['current.txt'])));
  expect(await screen.findByText('current.txt')).toBeInTheDocument();
});

it('reports a failed file read and recovers through the next file operation', async () => {
  mocks.projectListFiles.mockRejectedValueOnce(new Error('file list unavailable'));
  const view = mountProject(); await screen.findByText('Project A');
  await screen.findByText('pages.projectDetail.filesLoadFailed');
  expect(view.container.querySelector('.ant-spin-spinning')).toBeNull();
  expect(screen.getByText('pages.projectDetail.noFiles')).toBeInTheDocument();
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(['a'], 'upload.txt')] } });
  expect(await screen.findByText('A.txt')).toBeInTheDocument();
  expect(mocks.projectListFiles).toHaveBeenCalledTimes(2);
});

it('keeps the file read pending after the upload itself completes', async () => {
  const read = deferred<ReturnType<typeof fileList>>();
  const view = mountProject(); await screen.findByText('A.txt');
  mocks.projectListFiles.mockReturnValueOnce(read.promise);
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(['a'], 'upload.txt')] } });
  await waitFor(() => expect(mocks.projectListFiles).toHaveBeenCalledTimes(2));
  expect(view.container.querySelector('.ant-spin-spinning')).not.toBeNull();
  await act(async () => read.resolve(fileList('A', ['uploaded.txt'])));
  expect(await screen.findByText('uploaded.txt')).toBeInTheDocument();
});
