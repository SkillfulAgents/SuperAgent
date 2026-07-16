/**
 * Duplicate-delivery hardening: a per-integration UpdateDeduplicator owned by the manager
 * (survives a reconnect, resets on a bot-token change, dropped on permanent delete), and a
 * bounded awaited disconnect so two pollers never overlap.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { chatIntegrationManager } from './chat-integration-manager'
import { UpdateDeduplicator } from './update-deduplicator'

// Reach the manager singleton's private seams (as the sibling manager tests do).
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
  mgr.disconnectedSince?.clear?.()
  mgr.consecutiveFailures?.clear?.()
})

describe('ChatIntegrationManager — per-integration deduplicator', () => {
  it('uses a distinct deduplicator per integration', () => {
    const a = mgr.getOrCreateDeduplicator('int-dedup-2', 'tok-a')
    const b = mgr.getOrCreateDeduplicator('int-dedup-3', 'tok-b')
    expect(a).toBeInstanceOf(UpdateDeduplicator)
    expect(b).not.toBe(a)
  })

  it('reuses the same deduplicator for the same integration + token', () => {
    const a = mgr.getOrCreateDeduplicator('int-reuse', 'tok-a')
    const b = mgr.getOrCreateDeduplicator('int-reuse', 'tok-a')
    expect(b).toBe(a)
  })

  it('removeIntegration preserves the deduplicator so a redelivery after reconnect is still dropped', async () => {
    const dedup = mgr.getOrCreateDeduplicator('int-survive', 'tok-a')
    dedup.markDelivered('9001') // an update delivered before the reconnect
    mgr.connections.set('int-survive', fakeConn('int-survive', () => Promise.resolve()))

    await mgr.removeIntegration('int-survive') // the reconnect teardown

    expect(mgr.getOrCreateDeduplicator('int-survive', 'tok-a')).toBe(dedup) // same instance survives
    expect(dedup.isDuplicate('9001')).toBe(true) // and still remembers the pre-reconnect update
  })

  it('resets the deduplicator when the bot token changes (a new bot must not inherit old update ids)', () => {
    const old = mgr.getOrCreateDeduplicator('int-token', 'tok-old')
    old.markDelivered('7001')

    const fresh = mgr.getOrCreateDeduplicator('int-token', 'tok-new') // token changed → new notepad
    expect(fresh).not.toBe(old)
    expect(fresh.isDuplicate('7001')).toBe(false) // does not inherit the old bot's ids
  })

  it('forgetDeduplicator drops the notepad on permanent delete (no leak, no stale carry-over)', () => {
    const dedup = mgr.getOrCreateDeduplicator('int-del', 'tok-a')
    dedup.markDelivered('5001')

    mgr.forgetDeduplicator('int-del')

    expect(mgr.deduplicators.has('int-del')).toBe(false) // evicted, not leaked
    const recreated = mgr.getOrCreateDeduplicator('int-del', 'tok-a')
    expect(recreated).not.toBe(dedup) // a fresh id reused later starts clean
    expect(recreated.isDuplicate('5001')).toBe(false)
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

  it('leaves the swapped-in connection sibling state intact (does not wipe the new connection)', async () => {
    let releaseDisconnect: () => void = () => {}
    const connA = fakeConn('int-race2', () => new Promise<void>((r) => { releaseDisconnect = r }))
    const connB = fakeConn('int-race2', () => Promise.resolve())
    mgr.connections.set('int-race2', connA)

    const p = mgr.removeIntegration('int-race2') // captures connA, awaits its disconnect
    mgr.connections.set('int-race2', connB)      // concurrent reconnect swaps in connB...
    mgr.disconnectedSince.set('int-race2', 123)  // ...and records fresh sibling state for it
    releaseDisconnect()
    await p

    // The old teardown must not wipe the new connection's state, same as it must not delete connB.
    expect(mgr.disconnectedSince.get('int-race2')).toBe(123)
  })

  it('still clears sibling state on a genuine teardown (no swap)', async () => {
    mgr.connections.set('int-plain', fakeConn('int-plain', () => Promise.resolve()))
    mgr.disconnectedSince.set('int-plain', 456)

    await mgr.removeIntegration('int-plain')

    expect(mgr.disconnectedSince.has('int-plain')).toBe(false) // cleaned when this teardown owns the id
  })
})
