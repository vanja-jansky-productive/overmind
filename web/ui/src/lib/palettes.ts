// Colour palettes (Settings → Theme) — orthogonal to the light/dark mode (useTheme). A palette is
// `data-palette` on <html> (none = Default); its tokens live in index.css, one block per mode.
// Pure helpers, unit-tested in palettes.test.ts (which also checks these hexes against index.css
// and the index.html pre-paint script).

export type PaletteId = 'default' | 'earth' | 'dusk'
export type PaletteMode = 'light' | 'dark'

export const PALETTE_KEY = 'overmind.palette'
export const DEFAULT_PALETTE: PaletteId = 'default'

/** The three tokens a picker swatch previews: page, card, primary. `background` is also the
 *  PWA status-bar colour (meta theme-color). */
export interface Swatch {
  background: string
  card: string
  primary: string
}

export interface Palette {
  id: PaletteId
  label: string
  hint: string
  swatch: Record<PaletteMode, Swatch>
}

export const PALETTES: readonly Palette[] = [
  {
    id: 'default',
    label: 'Default',
    hint: 'Neutral grey, blue accent',
    swatch: {
      light: { background: '#ffffff', card: '#f5f6f8', primary: '#2563eb' },
      dark: { background: '#0b0c0e', card: '#131519', primary: '#6aa6ff' },
    },
  },
  {
    id: 'earth',
    label: 'Earth',
    hint: 'Warm paper and walnut, terracotta accent',
    swatch: {
      light: { background: '#f7f2ea', card: '#efe7da', primary: '#a14a2a' },
      dark: { background: '#1a1512', card: '#221c17', primary: '#e39a6f' },
    },
  },
  {
    id: 'dusk',
    label: 'Dusk',
    hint: 'Soft violet-grey, violet accent',
    swatch: {
      light: { background: '#faf9fc', card: '#f2f0f7', primary: '#6547c2' },
      dark: { background: '#121119', card: '#1a1823', primary: '#b3a0ff' },
    },
  },
]

/** A stored `overmind.palette` value → a known palette (anything else → Default). */
export function parsePalette(v: string | null | undefined): PaletteId {
  return PALETTES.some((p) => p.id === v) ? (v as PaletteId) : DEFAULT_PALETTE
}

export function paletteById(id: PaletteId): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0]
}

/** meta theme-color for a palette + mode: its page background. */
export const themeColor = (id: PaletteId, mode: PaletteMode) => paletteById(id).swatch[mode].background
