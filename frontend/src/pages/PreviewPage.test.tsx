import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import PreviewPage from './PreviewPage';

const mocks = vi.hoisted(() => ({ render: vi.fn(), getShare: vi.fn() }));
vi.mock('../utils/mermaid', () => ({ loadMermaid: async () => ({ render: mocks.render }) }));
vi.mock('../services/previewService', () => ({ previewService: { getShare: mocks.getShare } }));
function Controls() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/preview?lang=mermaid&c=B')}>change query</button>;
}
it('follows changed query content and ignores a late Mermaid result', async () => {
  let finish!: (value: { svg: string }) => void;
  mocks.render.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ svg: '<svg><text>B diagram</text></svg>' });
  render(<MemoryRouter initialEntries={['/preview?lang=mermaid&c=A']}><Controls /><PreviewPage /></MemoryRouter>);
  await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText('change query'));
  await waitFor(() => expect(screen.getByText('B diagram')).toBeInTheDocument());
  expect(mocks.render.mock.calls[0][0]).not.toBe(mocks.render.mock.calls[1][0]);
  await act(async () => finish({ svg: '<svg><text>A stale</text></svg>' }));
  expect(screen.queryByText('A stale')).not.toBeInTheDocument();
  expect(screen.getByText('B diagram')).toBeInTheDocument();
});

it.each([
  ['html', 'HTML 预览', '<button>Preview action</button>'],
  ['svg', 'SVG 预览', '<svg xmlns="http://www.w3.org/2000/svg"><text>Preview vector</text></svg>'],
])('isolates %s preview scripts from the application origin', (language, title, content) => {
  render(<MemoryRouter initialEntries={[`/preview?lang=${language}&c=${encodeURIComponent(content)}`]}><PreviewPage /></MemoryRouter>);
  const frame = screen.getByTitle(title);
  expect(frame.getAttribute('sandbox')?.split(' ')).toContain('allow-scripts');
  expect(frame.getAttribute('sandbox')?.split(' ')).not.toContain('allow-same-origin');
  expect(frame.getAttribute('srcdoc')).toContain(content);
});
