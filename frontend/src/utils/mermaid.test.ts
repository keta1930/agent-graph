import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { document.querySelector('#mermaid-cdn-script')?.remove(); delete window.mermaid; vi.resetModules(); });

it('shares concurrent script loading and initializes once', async () => {
  const { loadMermaid } = await import('./mermaid');
  const first = loadMermaid();
  const second = loadMermaid();
  expect(first).toBe(second);
  expect(document.querySelectorAll('#mermaid-cdn-script')).toHaveLength(1);
  const renderer = { initialize: vi.fn(), render: vi.fn() };
  window.mermaid = renderer;
  document.querySelector('#mermaid-cdn-script')!.dispatchEvent(new Event('load'));
  await expect(first).resolves.toBe(renderer);
  await expect(second).resolves.toBe(renderer);
  expect(renderer.initialize).toHaveBeenCalledTimes(1);
});

it('retries after script failure', async () => {
  const { loadMermaid } = await import('./mermaid');
  const failed = loadMermaid();
  const assertion = expect(failed).rejects.toThrow('failed to load');
  document.querySelector('#mermaid-cdn-script')!.dispatchEvent(new Event('error'));
  await assertion;
  const retry = loadMermaid();
  window.mermaid = { initialize: vi.fn(), render: vi.fn() };
  document.querySelector('#mermaid-cdn-script')!.dispatchEvent(new Event('load'));
  await expect(retry).resolves.toBe(window.mermaid);
});
