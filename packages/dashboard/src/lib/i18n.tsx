import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Locale = 'zh' | 'en';

export type TermKey = 'session' | 'route' | 'delegate' | 'bot' | 'task' | 'workspace' | 'inbox';

interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  toggleLocale: () => void;
  tr: (zh: string, en: string) => string;
  term: (key: TermKey) => string;
}

const STORAGE_KEY = 'clawteam.dashboard.locale';
let globalLocale: Locale = 'zh';

const TERMS: Record<Locale, Record<TermKey, string>> = {
  zh: {
    session: '会话',
    route: '路由',
    delegate: '委托',
    bot: '机器人',
    task: '任务',
    workspace: '工作区',
    inbox: '收件箱',
  },
  en: {
    session: 'Session',
    route: 'Route',
    delegate: 'Delegate',
    bot: 'Bot',
    task: 'Task',
    workspace: 'Workspace',
    inbox: 'Inbox',
  },
};

const I18nContext = createContext<I18nContextValue | null>(null);

function getInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'zh';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'zh' || stored === 'en') return stored;
  const navLang = window.navigator.language.toLowerCase();
  return navLang.startsWith('zh') ? 'zh' : 'en';
}

function setGlobalLocale(next: Locale) {
  globalLocale = next;
}

export function trGlobal(zh: string, en: string): string {
  return globalLocale === 'zh' ? zh : en;
}

export function termGlobal(key: TermKey): string {
  return TERMS[globalLocale][key];
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const initial = getInitialLocale();
    setGlobalLocale(initial);
    return initial;
  });

  useEffect(() => {
    setGlobalLocale(locale);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, locale);
    }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
  }, []);

  const toggleLocale = useCallback(() => {
    setLocaleState((prev) => (prev === 'zh' ? 'en' : 'zh'));
  }, []);

  const tr = useCallback((zh: string, en: string) => (locale === 'zh' ? zh : en), [locale]);

  const term = useCallback((key: TermKey) => TERMS[locale][key], [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      toggleLocale,
      tr,
      term,
    }),
    [locale, setLocale, toggleLocale, tr, term],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return ctx;
}
