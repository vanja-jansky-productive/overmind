import { expect, test } from 'vitest'

import { ApiError, sendErrorMessage, sessionErrorMessage } from './client'

test('live F3: a 409 on a session request shows the server reason (an approval answer refused), not "can\'t be controlled"', () => {
  const untouched = new ApiError('the terminal is not showing this question untouched — answer it there', 409)
  expect(sessionErrorMessage(untouched)).toBe('the terminal is not showing this question untouched — answer it there')
  const stale = new ApiError('the terminal is no longer showing this question', 409)
  expect(sessionErrorMessage(stale)).toBe('the terminal is no longer showing this question')
  expect(sendErrorMessage(stale)).toBe('the terminal is no longer showing this question')
})

test('a 409 with no reason keeps the generic text; other statuses keep theirs', () => {
  expect(sessionErrorMessage(new ApiError('HTTP 409', 409))).toBe("This session's backend can't be controlled from here")
  expect(sessionErrorMessage(new ApiError('', 409))).toBe("This session's backend can't be controlled from here")
  expect(sessionErrorMessage(new ApiError('unknown session: x', 404))).toBe('Session gone')
  expect(sessionErrorMessage(new ApiError('HTTP 502', 502))).toBe('host unreachable')
  expect(sessionErrorMessage(new Error('boom'))).toBe('boom')
})
