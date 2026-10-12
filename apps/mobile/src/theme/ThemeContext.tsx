import React, { createContext, useContext, useMemo } from 'react';
import { fieldTheme, redlightTheme, type Theme } from './theme';
import { useAppStore } from '../state/store';

const ThemeCtx = createContext<Theme>(fieldTheme);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const redLight = useAppStore((s) => s.redLight);
  const theme = useMemo(() => (redLight ? redlightTheme : fieldTheme), [redLight]);
  return <ThemeCtx.Provider value={theme}>{children}</ThemeCtx.Provider>;
}

export const useTheme = (): Theme => useContext(ThemeCtx);
