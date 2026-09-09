import { act, fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { message } from 'antd';
import FileUploadButton from './FileUploadButton';
import { I18nProvider } from '../../../i18n/I18nContext';

it('uses current files for consecutive pastes and removes the stable listener on unmount', () => {
  vi.spyOn(message, 'success').mockImplementation(() => Object.assign(() => undefined, { then: Promise.resolve(true).then.bind(Promise.resolve(true)), promise: Promise.resolve(true) }));
  const onChange = vi.fn();
  const add = vi.spyOn(document, 'addEventListener'); const remove = vi.spyOn(document, 'removeEventListener');
  const { unmount } = render(<I18nProvider><FileUploadButton onFilesChange={onChange} /></I18nProvider>);
  const file = new File(['image'], 'image.png', { type: 'image/png' });
  const paste = () => fireEvent.paste(document, { clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }] } });
  act(() => { paste(); paste(); });
  expect(onChange.mock.lastCall?.[0]).toHaveLength(2);
  expect(add.mock.calls.filter(([event]) => event === 'paste')).toHaveLength(1);
  unmount(); paste();
  expect(onChange).toHaveBeenCalledTimes(2);
  expect(remove.mock.calls.filter(([event]) => event === 'paste')).toHaveLength(1);
});

it('consumes each drop trigger once, uses latest callback and clears attachments between sessions', () => {
  const first = vi.fn(), second = vi.fn(); const file = new File(['a'], 'a.txt');
  const trigger = { files: [file], timestamp: 1 };
  const { rerender, container } = render(<I18nProvider><FileUploadButton onFilesChange={first} addFilesTrigger={trigger} /></I18nProvider>);
  expect(first.mock.lastCall?.[0]).toEqual([file]);
  rerender(<I18nProvider><FileUploadButton onFilesChange={second} addFilesTrigger={trigger} /></I18nProvider>);
  expect(second).not.toHaveBeenCalled();
  rerender(<I18nProvider><FileUploadButton onFilesChange={second} clearTrigger={1} addFilesTrigger={trigger} /></I18nProvider>);
  fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } });
  expect(second).toHaveBeenCalledWith([file]);
});
