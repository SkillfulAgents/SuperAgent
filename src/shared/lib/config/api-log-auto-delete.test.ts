import { describe, expect, it } from 'vitest'
import {
  DEFAULT_API_LOG_AUTO_DELETE_DAYS,
  resolveApiLogAutoDeleteDays,
} from './api-log-auto-delete'

describe('resolveApiLogAutoDeleteDays', () => {
  it('uses the agent override when set, including Never (0)', () => {
    expect(resolveApiLogAutoDeleteDays(90, 30)).toBe(90)
    expect(resolveApiLogAutoDeleteDays(0, 30)).toBe(0)
  })

  it('uses the app setting when the agent has no override', () => {
    expect(resolveApiLogAutoDeleteDays(undefined, 60)).toBe(60)
    expect(resolveApiLogAutoDeleteDays(undefined, 0)).toBe(0)
  })

  it('falls back to 30 days when neither is set', () => {
    expect(resolveApiLogAutoDeleteDays(undefined, undefined)).toBe(
      DEFAULT_API_LOG_AUTO_DELETE_DAYS,
    )
    expect(DEFAULT_API_LOG_AUTO_DELETE_DAYS).toBe(30)
  })
})
