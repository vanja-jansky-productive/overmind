import { createContext, useContext } from 'react'

import { DEFAULT_PALETTE, type PaletteId } from '@/lib/palettes'

export type ThemeChoice = 'system' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'

export const THEME_KEY = 'overmind.theme'

export interface ThemeState {
  theme: ThemeChoice
  resolved: ResolvedTheme
  setTheme: (t: ThemeChoice) => void
  /** The colour palette (lib/palettes.ts), applied in both modes. */
  palette: PaletteId
  setPalette: (p: PaletteId) => void
}

/** Dark first: `system` is light only when the OS explicitly prefers light. */
export function resolveTheme(choice: ThemeChoice, prefersLight: boolean): ResolvedTheme {
  if (choice === 'dark' || choice === 'light') return choice
  return prefersLight ? 'light' : 'dark'
}

export const ThemeContext = createContext<ThemeState>({
  theme: 'system',
  resolved: 'dark',
  setTheme: () => {},
  palette: DEFAULT_PALETTE,
  setPalette: () => {},
})

export function useTheme(): ThemeState {
  return useContext(ThemeContext)
}
