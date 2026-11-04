import { useNow } from '@/hooks/useNow'
import { relTime } from '@/lib/format'

/**
 * "5s" / "3m" since `at`, re-rendering only itself on the shared `every` clock (hooks/useNow.ts).
 * Text only, so it drops in where `relTime(at, now)` was. No `now` prop crosses a component
 * boundary: a leaf that needs the clock reads it itself.
 */
export function Ago({ at, every = 1000 }: { at: number | null | undefined; every?: number }) {
  return relTime(at, useNow(every))
}
