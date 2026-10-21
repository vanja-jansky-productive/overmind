import { expect, test } from 'vitest'

import { appendTranscript, formatElapsed, micUnavailableReason, pickMimeType } from './voice'

test('appendTranscript joins with exactly one space and ignores empty transcripts', () => {
  expect(appendTranscript('', 'Pozdrav.')).toBe('Pozdrav.')
  expect(appendTranscript('fix the bug', 'in overmind')).toBe('fix the bug in overmind')
  expect(appendTranscript('line one\n', 'two')).toBe('line one\ntwo')
  expect(appendTranscript('keep ', '  padded  ')).toBe('keep padded')
  expect(appendTranscript('unchanged', '   ')).toBe('unchanged')
})

test('pickMimeType prefers webm/opus, falls back to mp4, else the default', () => {
  expect(pickMimeType(() => true)).toBe('audio/webm;codecs=opus')
  expect(pickMimeType((t) => t === 'audio/mp4')).toBe('audio/mp4')
  expect(pickMimeType(() => false)).toBe('')
})

test('micUnavailableReason explains insecure origins first', () => {
  expect(micUnavailableReason({ secure: true, getUserMedia: true, recorder: true })).toBeNull()
  expect(micUnavailableReason({ secure: false, getUserMedia: false, recorder: true })).toMatch(/HTTPS/)
  expect(micUnavailableReason({ secure: true, getUserMedia: true, recorder: false })).toMatch(/cannot record/)
})

test('formatElapsed is m:ss', () => {
  expect(formatElapsed(0)).toBe('0:00')
  expect(formatElapsed(9_999)).toBe('0:09')
  expect(formatElapsed(75_000)).toBe('1:15')
})
