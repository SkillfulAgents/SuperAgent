/**
 * Duplicate-delivery hardening: a per-integration UpdateDeduplicator owned by the manager
 * (survives a reconnect), and a bounded awaited disconnect so two pollers never overlap.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { chatIntegrationManager } from './chat-integration-manager'
import { UpdateDeduplicator } from './update-deduplicator'

// Reach the manager singleton's private seams (matches the sup231 spec's pattern).
const mgr = chatIntegrationManager as any

function fakeConn(id: string, disconnect: () => Promise<void>) {
  return {
    messageUnsubscribe: null,
    interactiveUnsubscribe: null,
    errorUnsubscribe: null,
    typingHintUnsubscribe: null,
    integration: { id, provider: 'telegram' },
    connector: { disconnect },
  }
}

afterEach(() => {
  vi.useRealTimers()
  mgr.connections?.clear?.()
  mgr.deduplicators?.clear?.()
})

describe('ChatIntegrationManager — per-integration deduplicator', () => {
  it('uses a distinct deduplicator per integration', () => {
    const a = mgr.getOrCreateDeduplicator('int-dedup-2')
    const b = mgr.getOrCreateDeduplicator('int-dedup-3')
    expect(a).toBeInstanceOf(UpdateDeduplicator)
    expect(b).not.toBe(a)
  })

  it('removeIntegration preserves the deduplicator so a redelivery after reconnect is still dropped', async () => {
    const dedup = mgr.getOrCreateDeduplicator('int-survive')
    dedup.isDuplicate('9001') // an update handled before the reconnect
    mgr.connections.set('int-survive', fakeConn('int-survive', () => Promise.resolve()))

    await mgr.removeIntegration('int-survive') // the reconnect teardown

    expect(mgr.getOrCreateDeduplicator('int-survive')).toBe(dedup) // same instance survives
    expect(dedup.isDuplicate('9001')).toBe(true) // and still remembers the pre-reconnect update
  })
})

describe('ChatIntegrationManager — awaited disconnect (reconnect never overlaps pollers)', () => {
  it('does not resolve until the old connector disconnect resolves', async () => {
    vi.useFakeTimers()
    const conn = fakeConn('int-disc', () => new Promise<void>((res) => setTimeout(res, 100)))
    const p: Promise<void> = mgr.disconnectConnection(conn)
    let settled = false
    void p.then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(50)
    expect(settled).toBe(false) // still waiting for the old poller to stop

    await vi.advanceTimersByTimeAsync(100)
    expect(settled).toBe(true)
  })

  it('resolves within a bounded timeout even if disconnect hangs forever', async () => {
    vi.useFakeTimers()
    const conn = fakeConn('int-disc', () => new Promise<void>(() => { /* never resolves */ }))
    const p: Promise<void> = mgr.disconnectConnection(conn)
    let settled = false
    void p.then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(2999)
    expect(settled).toBe(false) // still within the ~3s bound

    await vi.advanceTimersByTimeAsync(2)
    expect(settled).toBe(true) // bounded at DISCONNECT_TIMEOUT_MS — proceeds, never wedges
  })
})

describe('ChatIntegrationManager — removeIntegration connection identity', () => {
  it('deletes only the connection it captured (concurrent-reconnect safety)', async () => {
    let releaseDisconnect: () => void = () => {}
    const connA = fakeConn('int-race', () => new Promise<void>((r) => { releaseDisconnect = r }))
    const connB = fakeConn('int-race', () => Promise.resolve())
    mgr.connections.set('int-race', connA)

    const p = mgr.removeIntegration('int-race') // captures connA, awaits its disconnect
    mgr.connections.set('int-race', connB)      // a concurrent reconnect swaps in a fresh connector
    releaseDisconnect()
    await p

    expect(mgr.connections.get('int-race')).toBe(connB) // must not orphan connB
  })
})
