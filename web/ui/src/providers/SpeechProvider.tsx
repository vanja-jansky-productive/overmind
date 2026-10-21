import { useCallback, useMemo, useState, type ReactNode } from 'react'

import { usePersistentState } from '@/hooks/usePersistentState'
import { useSettings } from '@/hooks/useSettings'
import { hasBrowserVoice, useSpeech } from '@/hooks/useSpeech'
import { SpeechContext, type SpeechPlayer } from '@/hooks/useSpeechPlayer'
import { parseRate } from '@/lib/operator'

/** One reader for the whole app: any agent message, the operator's replies and its announcements. */
export function SpeechProvider({ children }: { children: ReactNode }) {
  const settings = useSettings()
  const [rate, setRate] = usePersistentState<number>('overmind.speech.rate', 1, parseRate)
  const speech = useSpeech({ server: settings.speak, rate })
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const { speak: say, stop, unlock, state } = speech

  const speak = useCallback(
    async (text: string, key?: string) => {
      setActiveKey(key ?? null)
      await say(text)
    },
    [say],
  )

  const value = useMemo<SpeechPlayer>(
    () => ({
      available: settings.speak || hasBrowserVoice(),
      state,
      activeKey: state === 'idle' ? null : activeKey,
      speak,
      stop,
      unlock,
      rate,
      setRate,
    }),
    [settings.speak, state, activeKey, speak, stop, unlock, rate, setRate],
  )
  return <SpeechContext.Provider value={value}>{children}</SpeechContext.Provider>
}
