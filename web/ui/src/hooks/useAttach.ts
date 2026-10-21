import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type RefObject } from 'react'
import { toast } from 'sonner'

import { ApiError, api } from '@/api/client'
import { useSettings } from '@/hooks/useSettings'
import { dragHasFiles, formatBytes, insertPaths, overLimit, uploadName } from '@/lib/attach'

export interface AttachProgress {
  /** 1-based index of the file being uploaded. */
  index: number
  total: number
  name: string
}

function uploadError(err: unknown, host: string): string {
  if (!(err instanceof ApiError)) return (err as Error)?.message || 'upload failed'
  switch (err.status) {
    case 0:
      return 'network unreachable'
    case 404:
    case 501:
      return /unknown host/i.test(err.message) ? err.message : `${host}'s server does not take uploads (update overmind there)`
    case 502:
    case 504:
      return `${host} unreachable`
    default:
      return err.message || `HTTP ${err.status}`
  }
}

/**
 * Upload files to `host` one after another and type the stored copies' absolute paths into
 * the textarea at the caret (lib/attach.ts → insertPaths). `setValue` is the textarea's
 * controlled-state setter. `disabledReason` (non-null) refuses with a toast.
 */
export function useAttach({
  host,
  textarea,
  setValue,
  disabledReason = null,
}: {
  host: string
  textarea: RefObject<HTMLTextAreaElement | null>
  setValue: (value: string) => void
  disabledReason?: string | null
}) {
  const { uploadMaxMB } = useSettings()
  const [progress, setProgress] = useState<AttachProgress | null>(null)
  const busy = useRef(false)

  const attach = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      if (disabledReason) {
        toast.error(disabledReason)
        return
      }
      if (!host) {
        toast.error('No host to upload to')
        return
      }
      if (busy.current) {
        toast.error('Still uploading the previous files')
        return
      }
      busy.current = true
      const paths: string[] = []
      try {
        for (const [i, file] of files.entries()) {
          const name = uploadName(file)
          if (overLimit(file.size, uploadMaxMB)) {
            toast.error(`${name} is too large`, { description: `${formatBytes(file.size)} — the limit is ${uploadMaxMB} MB` })
            continue
          }
          setProgress({ index: i + 1, total: files.length, name })
          try {
            paths.push((await api.upload(host, file, name)).path)
          } catch (err) {
            toast.error(`Couldn't attach ${name}`, { description: uploadError(err, host) })
          }
        }
      } finally {
        busy.current = false
        setProgress(null)
      }
      if (!paths.length) return
      const el = textarea.current
      const value = el?.value ?? ''
      const next = insertPaths(value, el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length, paths)
      setValue(next.value)
      requestAnimationFrame(() => {
        const t = textarea.current
        if (!t) return
        t.focus()
        t.setSelectionRange(next.cursor, next.cursor)
      })
    },
    [host, textarea, setValue, disabledReason, uploadMaxMB],
  )

  /** Textarea `onPaste`: files on the clipboard are attached; plain text pastes as usual. */
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (!files.length) return
      e.preventDefault()
      void attach(files)
    },
    [attach],
  )

  return { attach, onPaste, progress, uploading: progress != null }
}

/**
 * Drag-and-drop of files onto an element: spread `bind` on it, show an overlay while
 * `dragging`. Only drags that carry files count (text or links dragged around the page are
 * left alone). Handled drops don't bubble to an outer zone.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  const accept = (e: DragEvent) => enabled && dragHasFiles(e.dataTransfer)
  const bind = {
    onDragEnter: (e: DragEvent) => {
      if (!accept(e)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current += 1
      setDragging(true)
    },
    onDragOver: (e: DragEvent) => {
      if (!accept(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (e: DragEvent) => {
      if (!accept(e)) return
      e.stopPropagation()
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    },
    onDrop: (e: DragEvent) => {
      if (!accept(e)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer.files ?? [])
      if (files.length) onFiles(files)
    },
  }
  return { dragging: dragging && enabled, bind }
}

/**
 * App-wide: a file dropped outside every drop zone must not make the browser navigate to it.
 * Zones call preventDefault themselves first, so this only catches the rest (no-drop cursor).
 */
export function usePreventFileNavigation() {
  useEffect(() => {
    const guard = (e: globalThis.DragEvent) => {
      if (e.defaultPrevented || !dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', guard)
    window.addEventListener('drop', guard)
    return () => {
      window.removeEventListener('dragover', guard)
      window.removeEventListener('drop', guard)
    }
  }, [])
}
