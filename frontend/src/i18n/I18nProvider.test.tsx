import { StrictMode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, useI18n, type I18nContextValue } from './index';

beforeEach(() => localStorage.clear());

function LanguageControls() {
  const { locale, setLocale, t } = useI18n();
  return <>
    <span>{locale}</span>
    <span>{t('common.save')}</span>
    <span>{t('missing.{{count}}.{{name}}', { count: 0, name: '' })}</span>
    <button onClick={() => setLocale('zh')}>Chinese</button>
  </>;
}

describe('I18nProvider', () => {
  it('uses the saved locale and changes language even if storage writes fail', () => {
    localStorage.setItem('app_locale', 'en');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied'); });
    render(<StrictMode><I18nProvider><LanguageControls /></I18nProvider></StrictMode>);

    expect(screen.getByText('Save')).toBeVisible();
    fireEvent.click(screen.getByText('Chinese'));
    expect(screen.getByText('保存')).toBeVisible();
    expect(screen.getByText('missing.0.')).toBeVisible();
  });

  it('falls back to browser language when localStorage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied'); });
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN');
    render(<I18nProvider><LanguageControls /></I18nProvider>);
    expect(screen.getByText('保存')).toBeVisible();
  });

  it('keeps the value stable across parent renders and the setter stable across locale changes', () => {
    localStorage.setItem('app_locale', 'en');
    const values: I18nContextValue[] = [];
    function Consumer() {
      const context = useI18n();
      values.push(context);
      return <button onClick={() => context.setLocale('zh')}>Chinese</button>;
    }
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const { rerender } = render(<I18nProvider><Consumer /></I18nProvider>);
    const first = values[0];
    rerender(<I18nProvider><Consumer /></I18nProvider>);
    expect(values[values.length - 1]).toBe(first);
    expect(getItem).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Chinese'));
    expect(values[values.length - 1]?.setLocale).toBe(first.setLocale);
    expect(values[values.length - 1]?.t('common.save')).toBe('保存');
  });
});
