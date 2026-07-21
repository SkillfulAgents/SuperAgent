import { describe, expect, it } from 'vitest'

import { getRequestUserId, runWithOptionalUser, runWithRequestUser } from './request-context'

describe('platform attribution request context', () => {
  it('keeps the request user across asynchronous work and restores the outer scope', async () => {
    expect(getRequestUserId()).toBeUndefined()

    await runWithRequestUser('outer-user', async () => {
      await Promise.resolve()
      expect(getRequestUserId()).toBe('outer-user')

      await runWithRequestUser('inner-user', async () => {
        await Promise.resolve()
        expect(getRequestUserId()).toBe('inner-user')
      })

      expect(getRequestUserId()).toBe('outer-user')
    })

    expect(getRequestUserId()).toBeUndefined()
  })

  it('preserves the active scope when the optional user is missing', async () => {
    await runWithRequestUser('outer-user', () =>
      runWithOptionalUser(null, () => {
        expect(getRequestUserId()).toBe('outer-user')
      }),
    )
  })
})
