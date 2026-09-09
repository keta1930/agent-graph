export type Locale = 'en' | 'zh';

export type TranslationNamespace = 'common' | 'pages' | 'components' | 'messages' | 'errors';

export interface TranslationTree {
  [key: string]: string | TranslationTree;
}

export type TranslationResource = Record<TranslationNamespace, TranslationTree>;

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}
