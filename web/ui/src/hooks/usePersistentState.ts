import { useCallback, useState } from 'react'

import { storage } from '@/lib/storage'

/**
 * useState backed by localStorage (`overmind.*` keys). `parse` validates the stored
 * string and returns the fallback for anything unexpected.
 */
export function usePersistentState<T extends string | number | boolean>(
  key: string,
  fallback: T,
  parse: (raw: string) => T | undefined = (raw) => raw as T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = storage.get(key)
    if (raw == null) return fallback
    return parse(raw) ?? fallback
  })
  const set = useCallback(
    (v: T) => {
      setValue(v)
      storage.set(key, String(v))
    },
    [key],
  )
  return [value, set]
}
