import { createContext, useContext } from 'react';
import type { I18nContextValue } from './types';

export const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used within I18nProvider');
  return context;
}
