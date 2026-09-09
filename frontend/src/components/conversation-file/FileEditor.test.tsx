import { render } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import FileEditor from './FileEditor';

const editor = vi.hoisted(() => ({ save: () => {}, mounts: 0 }));
vi.mock('../../i18n/hooks', () => ({ useT: () => (key: string) => key }));
vi.mock('@monaco-editor/react', async () => {
  const { useEffect } = await import('react');
  return { default: function MockEditor({ onMount }: { onMount: (instance: object, monaco: object) => void }) {
    useEffect(() => {
      editor.mounts++;
      onMount({ addCommand: (_key: number, callback: () => void) => { editor.save = callback; }, updateOptions: vi.fn() },
        { editor: { defineTheme: vi.fn(), setTheme: vi.fn() }, KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 } });
    }, [onMount]);
    return null;
  } };
});

it('uses the latest dirty state and save handler without re-registering the command', () => {
  const first = vi.fn();
  const latest = vi.fn();
  editor.mounts = 0;
  const props = { filename: 'file.txt', content: '', onChange: vi.fn() };
  const { rerender } = render(<FileEditor {...props} isDirty={false} onSave={first} />);
  editor.save();
  rerender(<FileEditor {...props} isDirty onSave={latest} />);
  editor.save();
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);
  expect(editor.mounts).toBe(1);
  rerender(<FileEditor {...props} isDirty readOnly onSave={latest} />);
  editor.save();
  expect(latest).toHaveBeenCalledTimes(1);
});
