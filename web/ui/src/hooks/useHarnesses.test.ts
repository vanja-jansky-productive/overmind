import { expect, test, vi } from 'vitest'

import { api } from '@/api/client'
import { invalidateHarnesses, prefetchHarnesses } from './useHarnesses'

test('one ask per host until Settings → Models saves a default (invalidateHarnesses), then the next read asks again', async () => {
  const ask = vi.spyOn(api, 'harnesses').mockResolvedValue({ host: 'laptop', harnesses: [] } as unknown as Awaited<ReturnType<typeof api.harnesses>>)
  prefetchHarnesses(['laptop'])
  prefetchHarnesses(['laptop'])
  expect(ask).toHaveBeenCalledTimes(1)
  invalidateHarnesses()
  prefetchHarnesses(['laptop'])
  expect(ask).toHaveBeenCalledTimes(2)
  ask.mockRestore()
})
