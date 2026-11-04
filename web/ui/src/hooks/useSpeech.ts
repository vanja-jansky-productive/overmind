import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { ApiError, api, isAbortError } from '@/api/client'
import { plainSpeech, speechChunks, speechLang } from '@/lib/operator'

export type SpeechState = 'idle' | 'loading' | 'playing'

// A few ms of silence: played inside a tap, it lets later replies play without one (iOS Safari
// only lets an <audio> element start on its own once a gesture has started it).
let silence: string | null = null
function silentWav(): string {
  if (silence) return silence
  // 8 kHz mono 8-bit PCM, 50 ms of the midpoint (silence).
  const n = 400
  const b = new Uint8Array(44 + n)
  const v = new DataView(b.buffer)
  const ascii = (o: number, t: string) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)))
  ascii(0, 'RIFF'); v.setUint32(4, 36 + n, true); ascii(8, 'WAVEfmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true)
  ascii(36, 'data'); v.setUint32(40, n, true); b.fill(128, 44)
  silence = `data:audio/wav;base64,${btoa(String.fromCharCode(...b))}`
  return silence
}

/** The browser can speak on its own (Web Speech API): the fallback when the server cannot. */
export const hasBrowserVoice = () => typeof window !== 'undefined' && 'speechSynthesis' in window

function browserVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices()
  const base = lang.slice(0, 2)
  return voices.find((v) => v.lang === lang) ?? voices.find((v) => v.lang.startsWith(base)) ?? null
}

/**
 * Read text aloud: POST /api/speak (OpenAI voice) per piece (speechChunks) on one reused <audio>
 * element, else — no key, or the server failed once — the browser's own voice. Call `unlock()`
 * from a tap (the mic button) so replies that arrive later may play; a new `speak` cuts the
 * current one.
 * `server`: this server offers /api/speak (settings.speak).
 */
export function useSpeech({ server, rate = 1 }: { server: boolean; rate?: number }) {
  const [state, setState] = useState<SpeechState>('idle')
  const audio = useRef<HTMLAudioElement | null>(null)
  const url = useRef<string | null>(null)
  const inflight = useRef<AbortController | null>(null)
  // Flips to false on the first server failure: the rest of the visit uses the browser's voice.
  // Playback speed: applied to every reply, and at once to the one playing.
  const rateRef = useRef(rate)
  useEffect(() => {
    rateRef.current = rate
    if (audio.current) {
      audio.current.defaultPlaybackRate = rate
      audio.current.playbackRate = rate
    }
  }, [rate])
  const useServer = useRef(server)
  useEffect(() => {
    useServer.current = server
  }, [server])

  const element = useCallback(() => {
    if (!audio.current) {
      // No onended → idle here: a reading is several pieces, and speak() says when it is done.
      const a = new Audio()
      a.preload = 'auto'
      audio.current = a
    }
    return audio.current
  }, [])

  const dropUrl = () => {
    if (url.current) URL.revokeObjectURL(url.current)
    url.current = null
  }

  const stop = useCallback(() => {
    inflight.current?.abort()
    inflight.current = null
    const a = audio.current
    if (a) {
      a.pause()
      a.removeAttribute('src')
      a.load()
    }
    dropUrl()
    if (hasBrowserVoice()) window.speechSynthesis.cancel()
    setState('idle')
  }, [])

  const unlock = useCallback(() => {
    if (state !== 'idle') return
    if (hasBrowserVoice() && !window.speechSynthesis.speaking) window.speechSynthesis.speak(new SpeechSynthesisUtterance(''))
    const a = element()
    if (a.src) return
    a.src = silentWav()
    a.play().catch(() => {})
  }, [element, state])

  const speakInBrowser = useCallback((text: string) => {
    if (!hasBrowserVoice()) return setState('idle')
    const plain = plainSpeech(text)
    if (!plain) return setState('idle')
    const u = new SpeechSynthesisUtterance(plain)
    u.lang = speechLang(plain)
    u.rate = rateRef.current
    const voice = browserVoice(u.lang)
    if (voice) u.voice = voice
    u.onend = () => setState('idle')
    u.onerror = () => setState('idle')
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(u)
    setState('playing')
  }, [])

  /** Play one piece on the shared element; resolves when it ends (or the reading is stopped). */
  const playPiece = useCallback(
    (blob: Blob, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const a = element()
        dropUrl()
        url.current = URL.createObjectURL(blob)
        a.src = url.current
        // A new source resets playbackRate to defaultPlaybackRate: set both.
        a.defaultPlaybackRate = rateRef.current
        a.playbackRate = rateRef.current
        const cleanup = () => {
          a.removeEventListener('ended', done)
          a.removeEventListener('error', fail)
          signal.removeEventListener('abort', done)
        }
        function done() {
          cleanup()
          resolve()
        }
        function fail() {
          cleanup()
          reject(a.error ?? new Error('playback failed'))
        }
        a.addEventListener('ended', done)
        a.addEventListener('error', fail)
        signal.addEventListener('abort', done)
        a.play().then(
          () => setState('playing'),
          (err) => {
            cleanup()
            reject(err)
          },
        )
      }),
    [element],
  )

  const speak = useCallback(
    async (text: string) => {
      stop()
      if (!useServer.current) return speakInBrowser(text)
      // Voiced piece by piece, all requested at once: the first (short) piece plays within a
      // second while the rest is still being voiced, instead of waiting for the whole reply.
      const pieces = speechChunks(text)
      if (!pieces.length) return setState('idle')
      const controller = new AbortController()
      inflight.current = controller
      setState('loading')
      const audios = pieces.map((p) => api.speak(p, { signal: controller.signal }))
      audios.forEach((p) => p.catch(() => {}))
      let i = 0
      try {
        for (; i < pieces.length; i += 1) {
          const blob = await audios[i]
          if (controller.signal.aborted) return
          await playPiece(blob, controller.signal)
          if (controller.signal.aborted) return
        }
        setState('idle')
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) return
        if ((err as DOMException)?.name === 'NotAllowedError') {
          setState('idle')
          toast.message('Tap the speaker on the reply to hear it')
          return
        }
        useServer.current = false
        const rest = i ? pieces.slice(i).join(' ') : text
        if (hasBrowserVoice()) {
          toast.message("Using this device's voice", { description: err instanceof ApiError ? err.message : String(err) })
          speakInBrowser(rest)
        } else {
          setState('idle')
          toast.error("Couldn't read the reply aloud", { description: err instanceof ApiError ? err.message : String(err) })
        }
      } finally {
        if (inflight.current === controller) inflight.current = null
      }
    },
    [stop, speakInBrowser, playPiece],
  )

  useEffect(
    () => () => {
      inflight.current?.abort()
      audio.current?.pause()
      if (url.current) URL.revokeObjectURL(url.current)
      if (hasBrowserVoice()) window.speechSynthesis.cancel()
    },
    [],
  )

  return { state, speak, stop, unlock }
}
