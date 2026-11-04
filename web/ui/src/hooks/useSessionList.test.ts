import { expect, test } from 'vitest'

import { listNote } from './useSessionList'

test('listNote: loading before any body, offline on error, refreshing on an explicit refresh, else updated', () => {
  expect(listNote(null, null, false)).toEqual({ text: 'loading…' })
  expect(listNote(null, 'boom', false)).toEqual({ text: 'offline — retrying', error: true })
  expect(listNote({}, 'boom', true)).toEqual({ text: 'offline — retrying', error: true })
  expect(listNote({}, null, true)).toEqual({ text: 'refreshing…' })
  // A localStorage snapshot counts: "updated 3m ago" right after a reload.
  expect(listNote({}, null, false)).toEqual({ text: 'updated' })
})
