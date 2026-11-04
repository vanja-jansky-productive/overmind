import { Ago } from '@/components/Ago'
import { useStamp, type Stamp } from '@/hooks/useStamp'

/**
 * The session header's "· 5s ago" (the last good capture of the current mode, from its stamp), or
 * "· connecting…" before one: `connected` is false until the mode's first capture lands, and again
 * after the terminal size changes (the stamp still holds the old capture's time then).
 */
export function UpdatedAgo({ stamp, connected }: { stamp: Stamp; connected: boolean }) {
  const at = useStamp(stamp)
  return connected && at ? <>· <Ago at={at} /> ago</> : '· connecting…'
}
