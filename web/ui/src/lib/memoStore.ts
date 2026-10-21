// Voice memos on this device until the server has them: each recording's record and its audio
// chunks (a few seconds each) in IndexedDB, written as they arrive — a crash, a closed app or a
// dead network loses at most one chunk. lib/memoRecorder.ts writes and drains it.

export interface PendingRecording {
  recId: string
  startedAt: number
  mimeType: string
  /** Segments 0…done-1 are complete (cut or stopped); a recording in progress writes segment `done`. */
  done: number
  /** Segments the server has stored. */
  uploaded: number[]
  /** Last sign of life from the tab recording it (a stale one is recovered by any tab). */
  heartbeat: number
  /** Set once recording ended: then the uploads are followed by `finish`. */
  stoppedAt?: number
  /** The last upload / finish failure (shown with a Retry). */
  error?: string
}

interface Chunk {
  recId: string
  seg: number
  i: number
  blob: Blob
}

const DB = 'overmind-memos'
const RECS = 'recordings'
const CHUNKS = 'chunks'

let dbp: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is unavailable'))
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => {
        const d = req.result
        d.createObjectStore(RECS, { keyPath: 'recId' })
        d.createObjectStore(CHUNKS, { keyPath: ['recId', 'seg', 'i'] })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    })
    dbp.catch(() => {
      dbp = null
    })
  }
  return dbp
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  const d = await db()
  const t = d.transaction(stores, mode)
  const finished = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error ?? new Error('transaction aborted'))
  })
  const out = await fn(t)
  await finished
  return out
}

/** All chunk keys of one segment (or the whole recording). */
const range = (recId: string, seg?: number) =>
  seg == null ? IDBKeyRange.bound([recId, -Infinity, -Infinity], [recId, Infinity, Infinity]) : IDBKeyRange.bound([recId, seg, -Infinity], [recId, seg, Infinity])

export const memoStore = {
  putRecording: (r: PendingRecording) => tx([RECS], 'readwrite', (t) => done(t.objectStore(RECS).put(r)).then(() => undefined)),
  getRecording: (recId: string) => tx([RECS], 'readonly', (t) => done(t.objectStore(RECS).get(recId)) as Promise<PendingRecording | undefined>),
  allRecordings: () => tx([RECS], 'readonly', (t) => done(t.objectStore(RECS).getAll()) as Promise<PendingRecording[]>),
  /** Merge `patch` into a stored record (no-op when it is gone). */
  updateRecording: (recId: string, patch: Partial<PendingRecording>) =>
    tx([RECS], 'readwrite', async (t) => {
      const s = t.objectStore(RECS)
      const cur = (await done(s.get(recId))) as PendingRecording | undefined
      if (cur) await done(s.put({ ...cur, ...patch }))
      return cur ? { ...cur, ...patch } : undefined
    }),
  putChunk: (c: Chunk) => tx([CHUNKS], 'readwrite', (t) => done(t.objectStore(CHUNKS).put(c)).then(() => undefined)),
  /** One segment's audio, chunks in order (an empty Blob when there are none). */
  segmentBlob: (recId: string, seg: number, type: string) =>
    tx([CHUNKS], 'readonly', async (t) => {
      const chunks = (await done(t.objectStore(CHUNKS).getAll(range(recId, seg)))) as Chunk[]
      return new Blob(
        chunks.sort((a, b) => a.i - b.i).map((c) => c.blob),
        { type },
      )
    }),
  /** The highest segment with any audio, or -1. */
  lastSegment: (recId: string) =>
    tx([CHUNKS], 'readonly', async (t) => {
      const keys = (await done(t.objectStore(CHUNKS).getAllKeys(range(recId)))) as [string, number, number][]
      return keys.reduce((max, k) => Math.max(max, k[1]), -1)
    }),
  dropSegment: (recId: string, seg: number) => tx([CHUNKS], 'readwrite', (t) => done(t.objectStore(CHUNKS).delete(range(recId, seg))).then(() => undefined)),
  /** The record and all its audio. */
  dropRecording: (recId: string) =>
    tx([RECS, CHUNKS], 'readwrite', async (t) => {
      await done(t.objectStore(CHUNKS).delete(range(recId)))
      await done(t.objectStore(RECS).delete(recId))
    }),
}
