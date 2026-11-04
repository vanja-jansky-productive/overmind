import { beforeEach, expect, test, vi } from 'vitest'

import type { OvermindResponse, Session } from '@/api/types'
import type { OvermindSnapshot } from '@/hooks/useOvermind'

// The stamps are module-global and only move forward: every test gets fresh modules.
let feedMod: typeof import('./overmindFeed')
let om: typeof import('@/hooks/useOvermind')
beforeEach(async () => {
  vi.resetModules()
  feedMod = await import('./overmindFeed')
  om = await import('@/hooks/useOvermind')
})

const s = (id: string): Session => ({ host: 'laptop', session_id: id, status: 'idle' })
const body = (at: number, ids = ['a'], over: Partial<OvermindResponse> = {}): OvermindResponse => ({
  self: 'laptop',
  snapshotAt: at,
  hosts: [
    { name: 'laptop', ok: true, fetchedAt: at - 100, sessions: ids.map(s) },
    { name: 'peer', ok: false, error: 'timeout', sessions: [] },
  ],
  ...over,
})
const signal = () => new AbortController().signal

function setup(snapshot: OvermindSnapshot | null = null, start = 1_000_000) {
  let t = start
  const save = vi.fn<(s: OvermindSnapshot) => void>()
  const feed = feedMod.createOvermindFeed(snapshot, { now: () => t, save })
  const changes = vi.fn()
  feed.subscribe(changes)
  return { feed, save, changes, tick: (ms: number) => (t += ms), now: () => t }
}

test('a reload paints the snapshot and stamps its clocks at once', () => {
  const snap = { overmind: body(900_000), at: 900_000 }
  const { feed } = setup(snap)
  expect(feed.get().overmind).toBe(snap.overmind)
  expect(om.overmindStamp.get()).toBe(900_000)
  expect(om.hostStamp('laptop').get()).toBe(899_900)
  expect(om.hostStamp('peer').get()).toBe(900_000) // no fetchedAt: the list clock
})

test('the first poll lands even when it equals the snapshot; then only clock moves re-render nothing', async () => {
  const { feed, save, changes, tick } = setup({ overmind: body(900_000), at: 900_000 })
  await feed.poll(async () => body(1_000_000), signal())
  expect(changes).toHaveBeenCalledTimes(1)
  const landed = feed.get()
  expect(save).toHaveBeenCalledTimes(1)

  tick(5_000)
  await feed.poll(async () => body(1_005_000), signal())
  expect(feed.get()).toBe(landed)
  expect(changes).toHaveBeenCalledTimes(1)
  expect(om.overmindStamp.get()).toBe(1_005_000)
  expect(om.hostStamp('laptop').get()).toBe(1_004_900)
  expect(save).toHaveBeenCalledTimes(1) // throttled

  tick(60_000)
  await feed.poll(async () => body(1_065_000), signal())
  expect(changes).toHaveBeenCalledTimes(1)
  expect(save).toHaveBeenCalledTimes(2)
  const saved = save.mock.lastCall![0]
  expect(saved.at).toBe(1_065_000)
  expect(saved.overmind.hosts[0].fetchedAt).toBe(1_064_900) // the new clocks, not the kept body's
})

test('a real change lands a new object', async () => {
  const { feed, changes } = setup()
  await feed.poll(async () => body(1_000_000), signal())
  await feed.poll(async () => body(1_005_000, ['a', 'b']), signal())
  expect(changes).toHaveBeenCalledTimes(2)
  expect(feed.get().overmind!.hosts[0].sessions.map((x) => x.session_id)).toEqual(['a', 'b'])
})

test('a client-built body with old clocks (applyOvermind on the kept body) moves no stamp back', async () => {
  const { feed, save, tick } = setup()
  await feed.poll(async () => body(1_000_000), signal())
  tick(3 * 60 * 60 * 1000)
  const late = 1_000_000 + 3 * 60 * 60 * 1000
  await feed.poll(async () => body(late), signal()) // unchanged: the kept body keeps its old clocks
  const kept = feed.get().overmind!
  expect(kept.snapshotAt).toBe(1_000_000)
  feed.apply({ ...kept, hosts: kept.hosts.map((h) => ({ ...h, spawnDirs: [] })) })
  expect(feed.get().overmind!.hosts[0].spawnDirs).toEqual([])
  expect(om.overmindStamp.get()).toBe(late)
  expect(om.hostStamp('laptop').get()).toBe(late - 100)
  const saved = save.mock.lastCall![0]
  expect(saved.at).toBe(late)
  expect(saved.overmind.snapshotAt).toBe(late)
  expect(saved.overmind.hosts[0].fetchedAt).toBe(late - 100)
})

test('drop hides a session now and from polls for a while, and keeps the clocks', async () => {
  const { feed, save, tick } = setup()
  await feed.poll(async () => body(1_000_000, ['a', 'b']), signal())
  tick(5_000)
  await feed.poll(async () => body(1_005_000, ['a', 'b']), signal())
  feed.drop('laptop', 'b')
  const ids = () => feed.get().overmind!.hosts[0].sessions.map((x) => x.session_id)
  expect(ids()).toEqual(['a'])
  expect(om.overmindStamp.get()).toBe(1_005_000)
  const saved = save.mock.lastCall![0]
  expect([saved.at, saved.overmind.hosts[0].fetchedAt]).toEqual([1_005_000, 1_004_900])

  tick(5_000)
  await feed.poll(async () => body(1_010_000, ['a', 'b']), signal())
  expect(ids()).toEqual(['a'])
  tick(feedMod.CLOSED_HIDE_MS)
  await feed.poll(async () => body(1_035_000, ['a', 'b']), signal())
  expect(ids()).toEqual(['a', 'b'])
})

test('an error shows until a poll succeeds, even one with an identical body', async () => {
  const { feed, changes } = setup()
  await feed.poll(async () => body(1_000_000), signal())
  const landed = feed.get().overmind
  await feed.poll(async () => Promise.reject(new Error('boom')), signal())
  expect(feed.get().error).toBe('boom')
  await feed.poll(async () => body(1_005_000), signal())
  expect(feed.get().error).toBeNull()
  expect(feed.get().overmind).toBe(landed)
  expect(changes).toHaveBeenCalledTimes(3) // land, error, recovery
})

test('refreshing: only an explicit refresh, kept through the poll it aborts, ended by the next', async () => {
  const { feed, changes } = setup()
  await feed.poll(async () => body(1_000_000), signal())
  expect(feed.get().refreshing).toBe(false)
  expect(changes).toHaveBeenCalledTimes(1) // a background poll never touches it

  feed.startRefresh()
  expect(feed.get().refreshing).toBe(true)
  const aborted = new AbortController()
  aborted.abort()
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
  await expect(feed.poll(async () => Promise.reject(abortErr), aborted.signal)).rejects.toBe(abortErr)
  expect(feed.get().refreshing).toBe(true)

  await feed.poll(async () => body(1_005_000), signal())
  expect(feed.get().refreshing).toBe(false)
})
