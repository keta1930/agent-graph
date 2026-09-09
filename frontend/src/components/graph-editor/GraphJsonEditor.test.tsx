import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import GraphJsonEditor, { type GraphJsonEditorHandle } from './GraphJsonEditor';
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="JSON" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
it('preserves edited and invalid text across unrelated parent renders; explicit session key resets', () => {
  const config = { name: 'A', description: 'saved', nodes: [] };
  const ref = createRef<GraphJsonEditorHandle>();
  const { rerender } = render(<GraphJsonEditor key="A" ref={ref} graphConfig={config} />);
  fireEvent.change(screen.getByLabelText('JSON'), { target: { value: '{ incomplete draft' } });
  rerender(<GraphJsonEditor key="A" ref={ref} graphConfig={{ ...config }} />);
  expect(screen.getByLabelText('JSON')).toHaveValue('{ incomplete draft');
  expect(ref.current!.validateAndGetConfig().valid).toBe(false);
  rerender(<GraphJsonEditor key="B" ref={ref} graphConfig={{ ...config, name: 'B' }} />);
  expect(ref.current!.validateAndGetConfig().config?.name).toBe('B');
});
it('rejects malformed node structures without modifying the draft', () => {
  const ref = createRef<GraphJsonEditorHandle>();
  render(<GraphJsonEditor ref={ref} graphConfig={{ name: 'A', description: '', nodes: [] }} />);
  const text = JSON.stringify({ name: 'A', nodes: [{ name: 'a', input_nodes: 4 }] });
  fireEvent.change(screen.getByLabelText('JSON'), { target: { value: text } });
  expect(ref.current!.validateAndGetConfig().valid).toBe(false);
  expect(ref.current!.getJsonText()).toBe(text);
});
