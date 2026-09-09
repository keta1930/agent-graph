import enTranslations from './en.json';
import zhTranslations from './zh.json';
import type { Locale, TranslationResource, TranslationTree } from '../types';

const translations: Record<Locale, TranslationResource> = {
  en: enTranslations,
  zh: zhTranslations,
};

/**
 * 获取指定语言和键的翻译文本
 * @param locale 语言代码
 * @param key 翻译键，支持嵌套访问（如 "pages.login.title"）
 * @returns 翻译文本，如果未找到则返回键本身
 */
export const getTranslation = (locale: Locale, key: string): string => {
  const keys = key.split('.');
  let value: string | TranslationTree = translations[locale];
  
  for (const k of keys) {
    if (typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, k)) {
      value = value[k];
    } else {
      // 开发环境警告
      if (import.meta.env.DEV) {
        console.warn(`Translation key not found: ${key} for locale: ${locale}`);
      }
      return key; // 返回键本身作为后备
    }
  }
  
  return typeof value === 'string' ? value : key;
};

/**
 * 获取指定语言的所有翻译资源
 * @param locale 语言代码
 * @returns 完整的翻译资源对象
 */
export const getAllTranslations = (locale: Locale): TranslationResource => {
  return translations[locale];
};
