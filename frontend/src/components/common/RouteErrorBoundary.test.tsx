import { lazy, Suspense, useEffect, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import PageLoading from './PageLoading';
import RouteErrorBoundary from './RouteErrorBoundary';

beforeEach(() => localStorage.setItem('app_locale', 'en'));

describe('route loading boundary', () => {
  it('preserves a healthy page instance and draft across path parameters and search changes', () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Editor() {
      const [draft, setDraft] = useState('');
      useEffect(() => { mounted(); return unmounted; }, []);
      return <input aria-label="Draft" value={draft} onChange={event => setDraft(event.target.value)} />;
    }
    render(<I18nProvider><MemoryRouter initialEntries={['/edit/A']}>
      <Link to="/edit/B">Next record</Link>
      <Link to="/edit/B?tab=preview">Preview tab</Link>
      <RouteErrorBoundary><Routes><Route path="/edit/:id" element={<Editor />} /></Routes></RouteErrorBoundary>
    </MemoryRouter></I18nProvider>);

    const input = screen.getByRole('textbox', { name: 'Draft' });
    fireEvent.change(input, { target: { value: 'unsaved text' } });
    fireEvent.click(screen.getByRole('link', { name: 'Next record' }));
    fireEvent.click(screen.getByRole('link', { name: 'Preview tab' }));

    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(input);
    expect(input).toHaveValue('unsaved text');
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
  });

  it('shows loading while the route module is pending, then displays the page', async () => {
    let resolvePage: (module: { default: () => React.ReactNode }) => void = () => undefined;
    const Page = lazy(() => new Promise<{ default: () => React.ReactNode }>((resolve) => { resolvePage = resolve; }));
    render(<I18nProvider><MemoryRouter><RouteErrorBoundary>
      <Suspense fallback={<PageLoading />}><Page /></Suspense>
    </RouteErrorBoundary></MemoryRouter></I18nProvider>);

    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    resolvePage({ default: () => <h1>Loaded page</h1> });
    expect(await screen.findByRole('heading', { name: 'Loaded page' })).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a recoverable lazy module failure and resets the boundary on navigation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const BrokenPage = lazy(() => Promise.reject(new Error('Chunk unavailable')));
    render(<I18nProvider><MemoryRouter initialEntries={['/broken']}>
      <Link to="/healthy">Healthy page</Link>
      <RouteErrorBoundary><Suspense fallback={<PageLoading />}><Routes>
        <Route path="/broken" element={<BrokenPage />} />
        <Route path="/healthy" element={<h1>Recovered</h1>} />
      </Routes></Suspense></RouteErrorBoundary>
    </MemoryRouter></I18nProvider>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load this page');
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to workspace' })).toHaveAttribute('href', '/workspace');
    fireEvent.click(screen.getByRole('link', { name: 'Healthy page' }));
    expect(await screen.findByRole('heading', { name: 'Recovered' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
