import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { I18nContext } from './context';
import type { Locale, I18nContextValue } from './types';
import { getTranslation } from './translations';

function getSavedLocale(): Locale {
  try {
    const saved = localStorage.getItem('app_locale');
    if (saved === 'en' || saved === 'zh') return saved;
  } catch {
    // 浏览器禁用存储时仍可使用当前会话的语言设置。
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getSavedLocale);
  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    try {
      localStorage.setItem('app_locale', newLocale);
    } catch {
      // 持久化失败不影响已经生效的语言切换。
    }
  }, []);
  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    const translation = getTranslation(locale, key);
    if (!params) return translation;
    return translation.replace(/\{\{(\w+)\}\}/g, (match: string, name: string) => {
      return params[name]?.toString() ?? match;
    });
  }, [locale]);
  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
