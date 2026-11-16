import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asc } from 'drizzle-orm'
import { backgroundInFlight, backgroundSettled } from '@shared/lib/background'
import type { AppDatabase } from '../db/drivers/types'
import { auditLog } from '../db/schema'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('@shared/lib/db', () => ({
  get db() { return testDb },
}))

import { logAuditEvent, logAuditEventAndWait, logAuditEventOrThrow } from './audit-log-service'

/** A database whose audit insert settles only when the test says so. */
function heldDatabase() {
  let settle!: { resolve: () => void; reject: (error: Error) => void }
  const stored = new Promise<void>((resolve, reject) => { settle = { resolve, reject } })
  const values = vi.fn(() => stored)
  testDb = { insert: () => ({ values }) } as unknown as AppDatabase
  return { values, ...settle }
}

async function rows() {
  return handle.db.select().from(auditLog).orderBy(asc(auditLog.createdAt), asc(auditLog.objectId)).all()
}

describe('audit log writes', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
  })

  afterEach(async () => {
    await backgroundSettled()
    vi.restoreAllMocks()
    await handle.close()
  })

  it('logAuditEvent resolves before the row is stored, and the write goes on in the background', async () => {
    const held = heldDatabase()

    await logAuditEvent({ userId: 'u1', object: 'agent', objectId: 'a1', action: 'created' })

    // Started at the call, not later: the insert is already issued.
    expect(held.values).toHaveBeenCalledTimes(1)
    expect(backgroundInFlight()).toEqual(['audit.log'])

    held.resolve()
    await backgroundSettled()
    expect(backgroundInFlight()).toEqual([])
  })

  it('logAuditEventAndWait resolves only once the row is stored', async () => {
    const held = heldDatabase()
    let resolved = false

    const waiting = logAuditEventAndWait({ userId: 'u1', object: 'browser_account', objectId: 'b1', action: 'used' })
      .then(() => { resolved = true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(resolved).toBe(false)

    held.resolve()
    await waiting
    expect(resolved).toBe(true)
  })

  it('stores consecutive events with the time and order of their calls', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-11-16T10:00:00.000Z'))
      await logAuditEvent({ userId: 'u1', object: 'agent', objectId: 'first', action: 'created', details: { name: 'A' } })
      vi.setSystemTime(new Date('2026-11-16T10:00:00.001Z'))
      await logAuditEvent({ userId: 'u1', object: 'agent', objectId: 'second', action: 'deleted' })
      vi.setSystemTime(new Date('2026-11-16T11:00:00.000Z'))
      await backgroundSettled()
    } finally {
      vi.useRealTimers()
    }

    expect((await rows()).map((row) => [row.objectId, row.action, row.createdAt.toISOString(), row.details])).toEqual([
      ['first', 'created', '2026-11-16T10:00:00.000Z', '{"name":"A"}'],
      ['second', 'deleted', '2026-11-16T10:00:00.001Z', null],
    ])
  })

  it('a failed write is logged and reaches neither the caller nor the background failure report', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const held = heldDatabase()

    await expect(logAuditEvent({ userId: 'u1', object: 'agent', objectId: 'a1', action: 'created' })).resolves.toBeUndefined()
    held.reject(new Error('disk full'))
    await backgroundSettled()

    expect(logged).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith('[audit] Failed to write audit log:', expect.objectContaining({ message: 'disk full' }))
  })

  it('logAuditEventOrThrow still surfaces a failed write', async () => {
    const held = heldDatabase()
    held.reject(new Error('disk full'))
    await expect(logAuditEventOrThrow({ userId: 'u1', object: 'secret', objectId: 'a1/KEY', action: 'revealed' })).rejects.toThrow('disk full')
  })
})
