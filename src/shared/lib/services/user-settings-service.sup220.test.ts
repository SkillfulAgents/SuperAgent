import { describe, it, expect, vi, beforeEach } from 'vitest'
import { user, userSettings } from '@shared/lib/db/schema'

// ---------------------------------------------------------------------------
// SUP-220 follow-on: user_settings now carries a FK to `user`. Non-auth mode
// persists settings under the reserved 'local' sentinel, which has no Better
// Auth user row, so the service must seed a backing 'local' user before writing
// — otherwise the FK rejects the insert and non-auth mode crashes on first
// settings access. These tests assert the seed happens for 'local' and only for
// 'local'.
// ---------------------------------------------------------------------------

const insertCalls: { table: unknown; values: Record<string, unknown> }[] = []
let selectRows: unknown[] = []

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ all: () => selectRows }),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        insertCalls.push({ table, values })
        return {
          onConflictDoNothing: () => ({ run: () => undefined }),
          onConflictDoUpdate: () => ({ run: () => undefined }),
        }
      },
    }),
  },
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ app: {} }),
}))

import { getUserSettings } from './user-settings-service'

beforeEach(() => {
  insertCalls.length = 0
  selectRows = []
})

describe('SUP-220 user-settings local sentinel seeding', () => {
  it('seeds a backing user before persisting settings for the local sentinel', () => {
    getUserSettings('local')

    const userInserts = insertCalls.filter((c) => c.table === user)
    const settingsInserts = insertCalls.filter((c) => c.table === userSettings)

    expect(userInserts).toHaveLength(1)
    expect(userInserts[0].values).toMatchObject({ id: 'local' })
    expect(settingsInserts).toHaveLength(1)
    expect(settingsInserts[0].values).toMatchObject({ userId: 'local' })

    // sentinel user must be seeded BEFORE the settings row (FK ordering)
    const userIdx = insertCalls.findIndex((c) => c.table === user)
    const settingsIdx = insertCalls.findIndex((c) => c.table === userSettings)
    expect(userIdx).toBeLessThan(settingsIdx)
  })

  it('does NOT seed a user row for a real (auth-mode) user id', () => {
    getUserSettings('real-user-123')

    expect(insertCalls.filter((c) => c.table === user)).toHaveLength(0)
    expect(insertCalls.filter((c) => c.table === userSettings)).toHaveLength(1)
  })

  it('does not insert anything when a settings row already exists', () => {
    selectRows = [{ settings: JSON.stringify({ theme: 'dark' }) }]
    const result = getUserSettings('local')

    expect(result.theme).toBe('dark')
    expect(insertCalls).toHaveLength(0)
  })
})
