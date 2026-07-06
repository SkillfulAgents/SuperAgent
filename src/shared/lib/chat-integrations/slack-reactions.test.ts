import { describe, it, expect } from 'vitest'
import { reactionRemovalSettled, createPerKeySerializer } from './slack-connector'

// ── reactionRemovalSettled ──────────────────────────────────────────────
// Decides whether we can stop tracking a thinking reaction after attempting to
// remove it. "Settled" (true) = the reaction is gone (removed, or never there),
// so drop the tracking key. Not settled (false) = a transient failure left the
// reaction live on Slack, so KEEP the key and retry on the next sweep. A Slack
// reaction never expires, so dropping tracking on a failed remove strands it forever.

describe('reactionRemovalSettled', () => {
  it('treats a successful removal as settled (drop the key)', () => {
    expect(reactionRemovalSettled(undefined)).toBe(true)
    expect(reactionRemovalSettled(null)).toBe(true)
  })

  it('treats "reaction/message/channel already gone" as settled — nothing left to retry', () => {
    expect(reactionRemovalSettled({ data: { error: 'no_reaction' } })).toBe(true)
    expect(reactionRemovalSettled({ data: { error: 'message_not_found' } })).toBe(true)
    expect(reactionRemovalSettled({ data: { error: 'channel_not_found' } })).toBe(true)
  })

  it('treats transient failures as NOT settled — keep the key and retry', () => {
    expect(reactionRemovalSettled({ data: { error: 'ratelimited' } })).toBe(false)
    expect(reactionRemovalSettled({ data: { error: 'internal_error' } })).toBe(false)
    // A plain network error has no Slack error code — assume the reaction may still be live.
    expect(reactionRemovalSettled(new Error('socket hang up'))).toBe(false)
  })
})

// ── createPerKeySerializer ──────────────────────────────────────────────
// Serializes async ops per key so fire-and-forget calls (reaction add from one
// tick, remove from the next) apply in call order instead of racing at the network.

describe('createPerKeySerializer', () => {
  it('runs same-key ops in call order even when the first settles later', async () => {
    const run = createPerKeySerializer()
    const order: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => { releaseA = r })

    const p1 = run('k', async () => { await gateA; order.push('A') }) // slow op enqueued first
    const p2 = run('k', async () => { order.push('B') })              // must wait behind A
    releaseA()
    await Promise.all([p1, p2])

    expect(order).toEqual(['A', 'B'])
  })

  it('does not serialize across different keys', async () => {
    const run = createPerKeySerializer()
    const order: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => { releaseA = r })

    const p1 = run('k1', async () => { await gateA; order.push('A') })
    const p2 = run('k2', async () => { order.push('B') }) // different key runs immediately
    await p2
    expect(order).toEqual(['B'])

    releaseA()
    await p1
    expect(order).toEqual(['B', 'A'])
  })

  it('a rejected op does not stall the next op on the same key', async () => {
    const run = createPerKeySerializer()
    const order: string[] = []

    const p1 = run('k', async () => { order.push('A'); throw new Error('boom') })
    const p2 = run('k', async () => { order.push('B') })

    await expect(p1).rejects.toThrow('boom')
    await p2
    expect(order).toEqual(['A', 'B'])
  })
})
