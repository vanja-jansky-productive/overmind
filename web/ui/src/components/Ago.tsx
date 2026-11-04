import { useAgoNow } from '@/hooks/useNow'
import { relTime } from '@/lib/format'

/** "5s" / "3m" since `at`, re-rendering only itself: every second while it shows seconds, every 30 s after (useAgoNow). */
export function Ago({ at }: { at: number | null | undefined }) {
  return relTime(at, useAgoNow(at))
}
