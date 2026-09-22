import type { DeliveryRecord, deliveryStore } from '../delivery-store'

/** Unit-test persistence for manager lifecycle tests; durable behavior is tested
 * against both real SQL drivers in delivery-queue.test.ts. */
export function memoryDeliveryStore(): typeof deliveryStore {
  const rows = new Map<string, DeliveryRecord>()
  return {
    accept: async (integrationId, event, route) => {
      if ([...rows.values()].some(row => row.integrationId === integrationId && row.externalId === route.externalId && row.eventId === event.id)) return false
      const now = new Date(); const id = crypto.randomUUID()
      rows.set(id, { id, integrationId, externalId: route.externalId, eventId: event.id, envelope: JSON.stringify({ event, route }),
        sessionId: null, state: 'pending', attempts: 0, owner: null, nextAttemptAt: now, noticeState: 'none', noticeAttempts: 0,
        error: null, createdAt: now, updatedAt: now })
      return true
    },
    due: async () => structuredClone([...rows.values()].filter(row => row.state === 'pending' || (row.state === 'sending' && !row.owner) || row.noticeState === 'pending')),
    nextDue: async available => {
      const row = [...rows.values()].filter(row => !available || available.includes(row.integrationId)).find(row => row.state === 'pending' || (row.state === 'sending' && !row.owner) || row.noticeState === 'pending')
      return row ? { at: row.nextAttemptAt } : undefined
    },
    ownsNotice: async (id, owner) => rows.get(id)?.owner === owner && rows.get(id)?.noticeState === 'sending',
    claim: async (row, owner, notice) => {
      const live = rows.get(row.id)
      if (!live || (notice ? live.noticeState !== 'pending' : live.state !== 'pending')) return false
      Object.assign(live, notice ? { owner, noticeState: 'sending', noticeAttempts: live.noticeAttempts + 1 } : { owner, state: 'preparing', attempts: live.attempts + 1 })
      return true
    },
    change: async (id, owner, patch) => {
      const row = rows.get(id)
      if (!row || row.owner !== owner || row.state === 'cancelled') return false
      Object.assign(row, patch); return true
    },
    handoff: async (id, owner, sessionId) => {
      const row = rows.get(id)
      if (!row || row.owner !== owner || row.state !== 'preparing') return false
      Object.assign(row, { state: 'sending', sessionId }); return true
    },
    cancel: async (id, externalId, exceptId) => {
      for (const row of rows.values()) if (row.integrationId === id && (!externalId || row.externalId === externalId) && row.id !== exceptId) Object.assign(row, { state: 'cancelled', owner: null, noticeState: 'none' })
    },
    cancelSession: async () => {},
    prune: async () => {},
    recover: async () => { rows.clear() },
    adopt: async (row, owner) => { if (row.owner) return false; row.owner = owner; return true },
  }
}
