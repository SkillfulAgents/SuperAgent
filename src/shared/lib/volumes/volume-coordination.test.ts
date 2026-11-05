import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appState, closeAppState, createLocalAppState, initializeAppState, LocalAppStateBackend } from '../app-state'
import {
  advanceVolumeGeneration,
  beginVolumeRead,
  readVolumeGenerations,
  VOLUME_CLAIM_TTL_MS,
  VOLUME_CLOCK_MARGIN_MS,
  volumeCoordinationKey,
  withVolumeClaim,
  type VolumeClaim,
  type VolumeClaimRequest,
  type VolumeGeneration,
  type VolumeRemote,
} from './volume-coordination'

const T0 = Date.parse('2026-11-05T12:00:00Z')
const remote: VolumeRemote = { provider: 's3', origin: 'https://s3.eu-west-1.amazonaws.com', bucket: 'secret-bucket' }
const key = volumeCoordinationKey(remote)
const WAIT = { waitTimeoutMs: 5_000, holdTimeoutMs: 600_000 } satisfies Partial<VolumeClaimRequest>
/** How long after a claim's last renewal another instance may call it dead. */
const DEAD_AFTER_MS = VOLUME_CLAIM_TTL_MS + VOLUME_CLOCK_MARGIN_MS

// One clock, as on one machine: tests move Date by hand, so a holder's own
// timers do not fire. Timers stay real unless a test fakes them too.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: T0 }) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)
function fakeAllTimers(): void {
  vi.useRealTimers()
  vi.useFakeTimers({ now: T0 })
}

/** A second process: separate module state over the same AppState (it is held on globalThis). */
async function secondProcess(): Promise<typeof import('./volume-coordination')> {
  vi.resetModules()
  return await import('./volume-coordination')
}

const record = async () => (await appState().get(key))?.value
const claimCount = async () => (await record())?.claims.length ?? 0
const realSleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    if (await condition()) return
    await realSleep(5)
  }
  throw new Error('condition never held')
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>(resolve => { open = resolve })
  return { open, opened }
}

/** A change in progress on `paths`: `entered` resolves inside the claim, and `finish()` ends it. */
function change(paths: string[] | undefined, request: Partial<VolumeClaimRequest> = {}, coordination = { withVolumeClaim }) {
  const entered = gate()
  const finishing = gate()
  let claim: VolumeClaim | undefined
  const done = coordination.withVolumeClaim(remote, { ...WAIT, paths, ...request }, async (held) => {
    claim = held
    entered.open()
    await finishing.opened
  })
  return { entered: entered.opened, done, finish: finishing.open, get claim() { return claim! } }
}
const hasEntered = (running: { entered: Promise<void> }) => Promise.race([running.entered.then(() => true), realSleep(0).then(() => false)])

const served = async (stamp: VolumeGeneration, path: string) => (await readVolumeGenerations(remote)).isCurrent(stamp, path)

describe('claims', () => {
  it('runs overlapping changes one at a time and unrelated ones together, across processes', async () => {
    const second = await secondProcess()
    const paths = ['a', 'a/b', 'a/b/c', 'a/d', 'e', 'e/f', 'g', 'a/b', 'e', 'a/d/h', 'g', 'a/b/c']
    const running = new Set<string>()
    let overlaps = 0
    let mostAtOnce = 0
    await Promise.all(paths.map((path, index) => (index % 2 ? second.withVolumeClaim : withVolumeClaim)(remote, { ...WAIT, paths: [path] }, async () => {
      for (const other of running) if (other === path || other.startsWith(`${path}/`) || path.startsWith(`${other}/`)) overlaps++
      running.add(path)
      mostAtOnce = Math.max(mostAtOnce, running.size)
      await realSleep(10)
      running.delete(path)
    })))
    expect(overlaps).toBe(0)
    expect(mostAtOnce).toBeGreaterThan(1)
    expect(await claimCount()).toBe(0)
  })

  it('lets siblings hold at once, and a name that merely starts the same is a sibling', async () => {
    const one = change(['a/b'])
    const two = change(['a/c'])
    const three = change(['a/bb'])
    // Each is inside its claim while the others still are.
    await Promise.all([one.entered, two.entered, three.entered])
    one.finish(); two.finish(); three.finish()
    await Promise.all([one.done, two.done, three.done])
  })

  it('makes an ancestor and a descendant wait for each other, whichever came first', async () => {
    const child = change(['a/b/c'])
    await child.entered
    const folder = change(['a'])
    await until(async () => await claimCount() === 2)
    const other = change(['a/b/c/d'])
    await until(async () => await claimCount() === 3)
    await realSleep(100)
    expect(await hasEntered(folder)).toBe(false)
    expect(await hasEntered(other)).toBe(false)
    child.finish(); await child.done
    await folder.entered
    expect(await hasEntered(other)).toBe(false)
    folder.finish(); await folder.done
    await other.entered
    other.finish(); await other.done
  })

  it('keeps arrival order: a folder change is not overtaken by later child writes', async () => {
    const order: string[] = []
    const first = change(['a/one'])
    await first.entered
    const folder = withVolumeClaim(remote, { ...WAIT, paths: ['a'] }, async () => { order.push('folder') })
    await until(async () => await claimCount() === 2)
    // Overlaps only the folder, which is still waiting. Without a queue this one
    // would run now, and enough of them would hold the folder off for good.
    const later = withVolumeClaim(remote, { ...WAIT, paths: ['a/two'] }, async () => { order.push('later child') })
    await until(async () => await claimCount() === 3)
    await realSleep(100)
    expect(order).toEqual([])
    first.finish()
    await Promise.all([first.done, folder, later])
    expect(order).toEqual(['folder', 'later child'])
  })

  it('claims all paths at once: changes that share paths in opposite order cannot deadlock', async () => {
    const order: string[] = []
    const first = change(['x', 'y'])
    await first.entered
    const crossed = withVolumeClaim(remote, { ...WAIT, paths: ['y', 'x'] }, async () => { order.push('crossed') })
    await until(async () => await claimCount() === 2)
    const partial = withVolumeClaim(remote, { ...WAIT, paths: ['z', 'y'] }, async () => { order.push('partial') })
    await until(async () => await claimCount() === 3)
    first.finish()
    await Promise.all([first.done, crossed, partial])
    expect(order).toEqual(['crossed', 'partial'])
  })

  it('offers a whole-remote claim for a provider that needs no paths', async () => {
    const coarse = change(undefined, { invalidates: ['a/b'] })
    await coarse.entered
    const other = change(['anything/at/all'])
    await until(async () => await claimCount() === 2)
    await realSleep(60)
    expect(await hasEntered(other)).toBe(false)
    coarse.finish(); await coarse.done
    await other.entered
    other.finish(); await other.done

    // A request naming too many paths is bounded the same way.
    const many = change(Array.from({ length: 17 }, (_, index) => `p${index}`))
    await many.entered
    expect((await record())?.claims[0]?.paths).toEqual([''])
    many.finish(); await many.done
    await expect(withVolumeClaim(remote, { ...WAIT, paths: [] }, async () => {})).rejects.toThrow(TypeError)
  })

  it('keeps remotes apart and keeps the identity out of the key', async () => {
    const first = change(['a'])
    await first.entered
    const otherBucket = withVolumeClaim({ provider: 's3', origin: 'https://s3.eu-west-1.amazonaws.com', bucket: 'other' }, { ...WAIT, paths: ['a'] }, async () => 'ran')
    const sameNameOtherProvider = withVolumeClaim({ provider: 'dropbox', accountId: 'secret-bucket' }, { ...WAIT, paths: ['a'] }, async () => 'ran')
    await expect(Promise.all([otherBucket, sameNameOtherProvider])).resolves.toEqual(['ran', 'ran'])
    first.finish(); await first.done
    expect(key.path).toMatch(/^coord:volume\/s3:/)
    expect(key.path).not.toContain('secret-bucket')
  })

  it('keeps tenants apart through AppState\'s scope', async () => {
    const backend = new LocalAppStateBackend()
    await closeAppState()
    await initializeAppState(createLocalAppState({ scope: { deploymentId: 'd', tenantId: 'one' }, backend }))
    await advanceVolumeGeneration(remote)
    expect(await record()).toBeDefined()
    expect(await createLocalAppState({ scope: { deploymentId: 'd', tenantId: 'two' }, backend }).get(key)).toBeNull()
  })

  it('validates the record', async () => {
    await expect(appState().set(key, { incarnation: 'not-a-uuid', generation: 0, floor: 0, invalidations: [], claims: [] })).rejects.toThrow()
  })

  it('refuses a change once too many are in line, and counts only live ones', async () => {
    const claims = Array.from({ length: 128 }, (_, index) => ({ id: randomUUID(), paths: [`dir${index}`], invalidates: [], expiresAt: Date.now() + VOLUME_CLAIM_TTL_MS }))
    await appState().set(key, { incarnation: randomUUID(), generation: 0, floor: 0, invalidations: [], claims })
    await expect(withVolumeClaim(remote, { ...WAIT, paths: ['one-more'] }, async () => {})).rejects.toThrow(/already in line/)
    expect(await claimCount()).toBe(128)

    advance(DEAD_AFTER_MS)
    await expect(withVolumeClaim(remote, { ...WAIT, paths: ['one-more'] }, async () => 'ran')).resolves.toBe('ran')
    expect(await claimCount()).toBe(0)
  })

  it('takes more competing arrivals than one compare-and-set loop allows by default', async () => {
    const second = await secondProcess()
    const arrivals = Array.from({ length: 70 }, (_, index) => change([`dir${index}`], {}, index % 2 ? second : { withVolumeClaim }))
    await Promise.all(arrivals.map(item => item.entered))
    expect(await claimCount()).toBe(70)
    arrivals.forEach(item => item.finish())
    await Promise.all(arrivals.map(item => item.done))
    expect(await claimCount()).toBe(0)
  })
})

describe('lapse and reacquisition', () => {
  /** A holder whose process died: its claim stays in the record, unrenewed. */
  async function deadHolder(paths: string[]): Promise<void> {
    await appState().set(key, {
      incarnation: randomUUID(),
      generation: 1,
      floor: 0,
      invalidations: [{ generation: 1, paths }],
      claims: [{ id: randomUUID(), paths, invalidates: paths, expiresAt: Date.now() + VOLUME_CLAIM_TTL_MS }],
    })
  }

  it('gives a dead holder\'s paths to a contender only past the clock margin', async () => {
    fakeAllTimers()
    await deadHolder(['a'])
    const contender = change(['a/b'], { waitTimeoutMs: 2 * DEAD_AFTER_MS })

    // Past the holder's deadline by the contender's clock, but within the margin:
    // that clock may simply run ahead of the holder's.
    await vi.advanceTimersByTimeAsync(DEAD_AFTER_MS - 1)
    expect(contender.claim).toBeUndefined()
    expect((await record())?.claims).toHaveLength(2)

    // Its next poll, at most a second on, finds the holder dead.
    await vi.advanceTimersByTimeAsync(1_001)
    await contender.entered
    // The turn was taken by a write that removed the dead claim.
    expect((await record())?.claims).toHaveLength(1)
    contender.finish(); await contender.done
  })

  it('stops a holder that lapsed, and its release leaves the successor alone', async () => {
    const stale = change(['a'])
    await stale.entered
    advance(DEAD_AFTER_MS)

    const successor = change(['a'], {}, await secondProcess())
    await successor.entered
    const successorId = (await record())?.claims[0]?.id
    expect((await record())?.claims).toHaveLength(1)

    // Its renewal finds the claim gone: it is told, and cannot come back.
    await expect(stale.claim.confirm()).rejects.toMatchObject({ name: 'LeaseLostError' })
    expect(stale.claim.signal.aborted).toBe(true)

    stale.finish()
    await stale.done
    expect((await record())?.claims.map(claim => claim.id)).toEqual([successorId])
    await expect(successor.claim.confirm()).resolves.toBeUndefined()
    successor.finish(); await successor.done
  })

  it('does not renew a claim that lapsed by its own clock, even when nobody took it', async () => {
    const held = change(['a'])
    await held.entered
    advance(VOLUME_CLAIM_TTL_MS)
    await expect(held.claim.confirm()).rejects.toMatchObject({ name: 'LeaseLostError' })
    held.finish(); await held.done
    expect(await claimCount()).toBe(0)
  })

  it('renews while the work runs, past any fixed expiry, and aborts when renewal stops working', async () => {
    fakeAllTimers()
    const held = change(['a'])
    await held.entered
    await vi.advanceTimersByTimeAsync(5 * VOLUME_CLAIM_TTL_MS)
    expect(held.claim.signal.aborted).toBe(false)
    expect((await record())?.claims[0]?.expiresAt).toBeGreaterThan(Date.now())

    // A contender finds it still held, long past the first 30 s.
    const refused = expect(withVolumeClaim(remote, { ...WAIT, paths: ['a'], waitTimeoutMs: 1_000 }, async () => {})).rejects.toMatchObject({ name: 'LeaseWaitTimeoutError' })
    await vi.advanceTimersByTimeAsync(1_500)
    await refused

    vi.spyOn(appState(), 'compareAndSet').mockRejectedValue(new Error('AppState unreachable'))
    await vi.advanceTimersByTimeAsync(VOLUME_CLAIM_TTL_MS)
    expect(held.claim.signal.reason).toMatchObject({ name: 'LeaseLostError' })
    vi.restoreAllMocks()
    held.finish(); await held.done
  })

  it('ends an operation at its deadline, and refuses a request that would outlive it', async () => {
    fakeAllTimers()
    const first = change(['a'], { holdTimeoutMs: 45_000 })
    await first.entered
    await vi.advanceTimersByTimeAsync(35_000)
    expect(first.claim.signal.aborted).toBe(false)
    await expect(first.claim.confirm({ minRemainingMs: 20_000 })).rejects.toMatchObject({ name: 'LeaseLostError' })
    first.finish(); await first.done

    const second = change(['a'], { holdTimeoutMs: 45_000 })
    await second.entered
    await vi.advanceTimersByTimeAsync(45_000)
    expect(second.claim.signal.reason).toMatchObject({ name: 'LeaseLostError' })
    await expect(second.claim.confirm()).rejects.toMatchObject({ name: 'LeaseLostError' })
    second.finish(); await second.done
  })

  it('counts the operation\'s deadline from its turn, not from its arrival', async () => {
    fakeAllTimers()
    const first = change(['a'])
    await first.entered
    const waiting = change(['a'], { holdTimeoutMs: 45_000, waitTimeoutMs: 120_000 })
    await vi.advanceTimersByTimeAsync(60_000)
    first.finish(); await first.done
    await waiting.entered
    await vi.advanceTimersByTimeAsync(44_999)
    expect(waiting.claim.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(waiting.claim.signal.aborted).toBe(true)
    waiting.finish(); await waiting.done
  })

  it('never lets a generation match again once the record has expired', async () => {
    await advanceVolumeGeneration(remote, ['elsewhere'])
    const old = (await beginVolumeRead(remote, 'a'))!
    expect(old.generation).toBe(1)
    expect(await served(old, 'a')).toBe(true)

    advance(60 * 60_000) // The idle record's expiry.
    expect(await record()).toBeUndefined()
    // A slow fill finishing now is not served, with or without a new record.
    expect(await served(old, 'a')).toBe(false)
    await advanceVolumeGeneration(remote, ['elsewhere'])
    const fresh = (await beginVolumeRead(remote, 'a'))!
    expect(fresh.generation).toBe(old.generation)
    expect(fresh.incarnation).not.toBe(old.incarnation)
    expect(await served(old, 'a')).toBe(false)
    expect(await served(fresh, 'a')).toBe(true)
  })

  it('keeps a record its holder is renewing, whatever else expires', async () => {
    const held = change(['a'])
    await held.entered
    advance(20_000)
    await held.claim.confirm()
    advance(60 * 60_000 - 1)
    expect(await record()).toBeDefined()
    held.finish(); await held.done
  })
})

describe('generations and cache publication', () => {
  it('rejects a fill that began before a change, however late it lands, and keeps unrelated listings', async () => {
    const fill = (await beginVolumeRead(remote, 'a/b'))!
    const unrelated = (await beginVolumeRead(remote, 'c'))!
    const second = await secondProcess()
    await second.withVolumeClaim(remote, { ...WAIT, paths: ['a/b/file'] }, async () => {})
    expect(await served(fill, 'a/b')).toBe(false)
    expect(await served(unrelated, 'c')).toBe(true)
    // Read-after-write: a read taken after the change stands.
    const next = (await beginVolumeRead(remote, 'a/b'))!
    expect(await served(next, 'a/b')).toBe(true)
  })

  it('invalidates the path, what is under it and its parent, and nothing else', async () => {
    const stamp = (await beginVolumeRead(remote, 'other'))!
    await advanceVolumeGeneration(remote, ['a/b/c'])
    expect(await served(stamp, 'a/b/c')).toBe(false)
    expect(await served(stamp, 'a/b/c/d/e')).toBe(false)
    expect(await served(stamp, 'a/b')).toBe(false)
    expect(await served(stamp, 'a/b/')).toBe(false)
    expect(await served(stamp, 'a')).toBe(true)
    expect(await served(stamp, 'a/b/cc')).toBe(true)
    expect(await served(stamp, 'a/b/sibling')).toBe(true)
    expect(await served(stamp, '')).toBe(true)
    await advanceVolumeGeneration(remote)
    expect(await served(stamp, 'anything')).toBe(false)
  })

  it('treats a flat id, as Drive uses, as its own listing', async () => {
    const stamp = (await beginVolumeRead(remote, 'folderA'))!
    await advanceVolumeGeneration(remote, ['folderA'])
    expect(await served(stamp, 'folderA')).toBe(false)
    expect(await served(stamp, 'folderB')).toBe(true)
  })

  it('offers no generation for a listing that a change in line or running affects', async () => {
    const running = change(['a/b/file'])
    await running.entered
    expect(await beginVolumeRead(remote, 'a/b')).toBeNull()
    expect(await beginVolumeRead(remote, 'a/b/file')).toBeNull()
    expect(await beginVolumeRead(remote, 'a/b/file/under')).toBeNull()
    expect(await beginVolumeRead(remote, 'a')).not.toBeNull()
    expect(await beginVolumeRead(remote, 'a/b/sibling')).not.toBeNull()
    running.finish(); await running.done
    expect(await beginVolumeRead(remote, 'a/b')).not.toBeNull()

    // In line, not yet running: its write may land before any read that begins now ends.
    const holder = change(['x'])
    await holder.entered
    const behind = change(['x/y'])
    await until(async () => await claimCount() === 2)
    expect(await beginVolumeRead(remote, 'x/y')).toBeNull()
    holder.finish(); behind.finish()
    await Promise.all([holder.done, behind.done])
  })

  it('offers a generation again once the change that held it died', async () => {
    const running = change(['a'])
    await running.entered
    expect(await beginVolumeRead(remote, 'a')).toBeNull()
    advance(DEAD_AFTER_MS)
    expect(await beginVolumeRead(remote, 'a')).not.toBeNull()
    running.finish(); await running.done
  })

  it('invalidates only what a coarse claim names, not everything it conflicts over', async () => {
    const unrelated = (await beginVolumeRead(remote, 'c'))!
    const running = change(undefined, { invalidates: ['a/file'] })
    await running.entered
    expect(await served(unrelated, 'c')).toBe(true)
    expect(await beginVolumeRead(remote, 'c')).not.toBeNull()
    expect(await beginVolumeRead(remote, 'a')).toBeNull()
    running.finish(); await running.done
  })

  it('lets a holder republish a listing its own change updated, as a chain', async () => {
    let listing = (await beginVolumeRead(remote, 'a'))!
    for (const file of ['a/one', 'a/two']) {
      await withVolumeClaim(remote, { ...WAIT, paths: [file] }, async (claim) => {
        // Readers see the listing stale from the change's arrival; the holder
        // alone knows only its own change is newer.
        expect(await served(listing, 'a')).toBe(false)
        expect(await claim.isCurrent(listing, 'a')).toBe(true)
        listing = claim.generation
      })
      expect(await served(listing, 'a')).toBe(true)
    }
  })

  it('stops a holder republishing over another change, whichever arrived first', async () => {
    const base = (await beginVolumeRead(remote, 'a'))!
    const first = change(['a/one'])
    await first.entered
    const second = change(['a/two'])
    await second.entered
    expect(await first.claim.isCurrent(base, 'a')).toBe(false)
    expect(await second.claim.isCurrent(base, 'a')).toBe(false)
    first.finish(); second.finish()
    await Promise.all([first.done, second.done])
  })

  it('rejects what a stale holder publishes once a successor has arrived, even if it lands after', async () => {
    const stale = change(['a'])
    await stale.entered
    const stamped = stale.claim.generation
    expect(await served(stamped, 'a')).toBe(true)
    advance(DEAD_AFTER_MS)
    const successor = change(['a'])
    await successor.entered
    expect(await served(stamped, 'a')).toBe(false)
    expect(await served(successor.claim.generation, 'a')).toBe(true)
    expect(await stale.claim.isCurrent(stamped, 'a')).toBe(false)
    stale.finish(); successor.finish()
    await Promise.all([stale.done, successor.done])
  })

  it('stops a lapsed holder republishing once its claim is gone, with no successor to reject it', async () => {
    const base = (await beginVolumeRead(remote, 'a'))!
    const stale = change(['a/file'])
    await stale.entered
    expect(await stale.claim.isCurrent(base, 'a')).toBe(true)
    advance(DEAD_AFTER_MS)
    await withVolumeClaim(remote, { ...WAIT, paths: ['elsewhere'] }, async () => {})
    expect(await stale.claim.isCurrent(base, 'a')).toBe(false)
    stale.finish(); await stale.done
  })

  it('marks a lapsed holder\'s paths changed again when its work settles: its request may have landed late', async () => {
    const stale = change(['a'])
    await stale.entered
    advance(DEAD_AFTER_MS)
    // Removes the dead claim, so a read may begin, and may miss the late write.
    await withVolumeClaim(remote, { ...WAIT, paths: ['elsewhere'] }, async () => {})
    const fill = (await beginVolumeRead(remote, 'a'))!
    expect(await served(fill, 'a')).toBe(true)
    stale.finish(); await stale.done
    expect(await served(fill, 'a')).toBe(false)
  })

  it('stays bounded: a generation older than what is remembered counts as stale everywhere', async () => {
    const old = (await beginVolumeRead(remote, 'quiet'))!
    for (let index = 0; index < 128; index++) await advanceVolumeGeneration(remote, [`busy/${index}`])
    expect(await served(old, 'quiet')).toBe(true)
    await advanceVolumeGeneration(remote, ['busy/one-more'])
    expect((await record())?.invalidations).toHaveLength(128)
    expect(await served(old, 'quiet')).toBe(false)
    const fresh = (await beginVolumeRead(remote, 'quiet'))!
    expect(await served(fresh, 'quiet')).toBe(true)
  })

  it('gives competing first reads one incarnation', async () => {
    const stamps = await Promise.all(Array.from({ length: 8 }, () => beginVolumeRead(remote, 'a')))
    expect(new Set(stamps.map(stamp => stamp?.incarnation)).size).toBe(1)
  })
})

describe('cancellation and lost answers', () => {
  it('leaves nothing behind when a waiter is aborted: no claim, no subscription, nobody held up', async () => {
    const holder = change(['a/b'])
    await holder.entered
    const unsubscribed = vi.fn()
    const state = appState()
    const subscribe = state.subscribe.bind(state)
    const subscribed = vi.spyOn(state, 'subscribe').mockImplementation(async (channels, listener, options) => {
      const subscription = await subscribe(channels, listener, options)
      return { unsubscribe: async () => { unsubscribed(); await subscription.unsubscribe() } }
    })

    const controller = new AbortController()
    const ran = vi.fn(async () => {})
    const waiter = withVolumeClaim(remote, { ...WAIT, paths: ['a'], signal: controller.signal }, ran)
    await until(() => subscribed.mock.calls.length === 1)
    await until(async () => await claimCount() === 2)
    const reason = new Error('the client went away')
    controller.abort(reason)
    await expect(waiter).rejects.toBe(reason)

    expect(ran).not.toHaveBeenCalled()
    expect(unsubscribed).toHaveBeenCalledTimes(1)
    expect((await record())?.claims).toHaveLength(1)
    // Overlaps only the aborted waiter, so it runs while the holder still does.
    const after = change(['a/c'])
    await after.entered
    holder.finish(); after.finish()
    await Promise.all([holder.done, after.done])
    expect(await claimCount()).toBe(0)
  })

  it('leaves no timers behind when a waiter is aborted', async () => {
    fakeAllTimers()
    const holder = change(['a'])
    await holder.entered
    const controller = new AbortController()
    const timersBefore = vi.getTimerCount()
    const refused = expect(withVolumeClaim(remote, { ...WAIT, paths: ['a'], signal: controller.signal }, async () => {})).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(10)
    expect(vi.getTimerCount()).toBeGreaterThan(timersBefore)
    controller.abort()
    await refused
    expect(vi.getTimerCount()).toBe(timersBefore)
    holder.finish(); await holder.done
    expect(vi.getTimerCount()).toBe(0)
  })

  it('writes nothing for a signal that is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    await expect(withVolumeClaim(remote, { ...WAIT, signal: controller.signal }, async () => {})).rejects.toThrow('gone')
    expect(await record()).toBeUndefined()
  })

  it('does not run work when the signal aborts during the arrival, and takes it back', async () => {
    const state = appState()
    const compareAndSet = state.compareAndSet.bind(state)
    const controller = new AbortController()
    vi.spyOn(state, 'compareAndSet').mockImplementationOnce(async (written, expected, value, options) => {
      const answer = await compareAndSet(written, expected, value, options)
      controller.abort(new Error('gone'))
      return answer
    })
    const ran = vi.fn(async () => {})
    await expect(withVolumeClaim(remote, { ...WAIT, paths: ['a'], signal: controller.signal }, ran)).rejects.toThrow('gone')
    expect(ran).not.toHaveBeenCalled()
    expect(await claimCount()).toBe(0)
  })

  it('gives up after waitTimeoutMs and frees its place', async () => {
    fakeAllTimers()
    const holder = change(['a'])
    await holder.entered
    const refused = expect(withVolumeClaim(remote, { ...WAIT, paths: ['a'], waitTimeoutMs: 80 }, async () => {})).rejects.toMatchObject({ name: 'LeaseWaitTimeoutError' })
    await vi.advanceTimersByTimeAsync(80)
    await refused
    expect(await claimCount()).toBe(1)
    holder.finish(); await holder.done
  })

  it('takes back an arrival whose answer was lost', async () => {
    const state = appState()
    const compareAndSet = state.compareAndSet.bind(state)
    vi.spyOn(state, 'compareAndSet').mockImplementationOnce(async (written, expected, value, options) => {
      await compareAndSet(written, expected, value, options)
      throw new Error('the answer was lost')
    })
    const ran = vi.fn(async () => {})
    await expect(withVolumeClaim(remote, { ...WAIT, paths: ['a'] }, ran)).rejects.toThrow('the answer was lost')
    expect(ran).not.toHaveBeenCalled()
    expect(await claimCount()).toBe(0)
  })

  it('does not run work on an arrival answered too late to rely on, and takes it back', async () => {
    const state = appState()
    const compareAndSet = state.compareAndSet.bind(state)
    vi.spyOn(state, 'compareAndSet').mockImplementationOnce(async (written, expected, value, options) => {
      const answer = await compareAndSet(written, expected, value, options)
      advance(VOLUME_CLAIM_TTL_MS)
      return answer
    })
    const ran = vi.fn(async () => {})
    await expect(withVolumeClaim(remote, { ...WAIT, paths: ['a'] }, ran)).rejects.toMatchObject({ name: 'LeaseLostError' })
    expect(ran).not.toHaveBeenCalled()
    expect(await claimCount()).toBe(0)
  })

  it('counts a renewal answered too late as lost', async () => {
    const held = change(['a'])
    await held.entered
    const state = appState()
    const compareAndSet = state.compareAndSet.bind(state)
    vi.spyOn(state, 'compareAndSet').mockImplementationOnce(async (written, expected, value, options) => {
      const answer = await compareAndSet(written, expected, value, options)
      advance(VOLUME_CLAIM_TTL_MS)
      return answer
    })
    await expect(held.claim.confirm()).rejects.toMatchObject({ name: 'LeaseLostError' })
    held.finish(); await held.done
    expect(await claimCount()).toBe(0)
  })

  it('leaves a claim whose removal failed to lapse, without failing the work', async () => {
    const result = await withVolumeClaim(remote, { ...WAIT, paths: ['a'] }, async () => {
      vi.spyOn(appState(), 'compareAndSet').mockRejectedValueOnce(new Error('unreachable'))
      return 'done'
    })
    expect(result).toBe('done')
    expect(await claimCount()).toBe(1)
    advance(DEAD_AFTER_MS)
    const next = change(['a'])
    await next.entered
    next.finish(); await next.done
  })
})

describe('waking waiters', () => {
  it('finds its turn by polling when the wake is lost', async () => {
    const holder = change(['a'])
    await holder.entered
    const publish = vi.spyOn(appState(), 'publish').mockResolvedValue(undefined)
    const waiter = change(['a'])
    await until(async () => await claimCount() === 2)
    holder.finish(); await holder.done
    await waiter.entered
    expect(publish).toHaveBeenCalledTimes(1)
    waiter.finish(); await waiter.done
  })

  it('finds its turn by polling when PubSub is down altogether', async () => {
    const holder = change(['a'])
    await holder.entered
    vi.spyOn(appState(), 'publish').mockRejectedValue(new Error('down'))
    vi.spyOn(appState(), 'subscribe').mockRejectedValue(new Error('down'))
    const waiter = change(['a'])
    await until(async () => await claimCount() === 2)
    holder.finish(); await holder.done
    await waiter.entered
    waiter.finish(); await waiter.done
  })

  it('grants nothing on a wake: a waiter woken while the claim is held only looks again', async () => {
    const holder = change(['a'])
    await holder.entered
    const subscribed = vi.spyOn(appState(), 'subscribe')
    const waiter = change(['a'])
    await until(() => subscribed.mock.calls.length === 1)
    const [channels, listener] = subscribed.mock.calls[0]!
    await listener({}, channels[0]!)
    await realSleep(60)
    expect(await hasEntered(waiter)).toBe(false)
    holder.finish(); await holder.done
    await waiter.entered
    waiter.finish(); await waiter.done
  })

  it('wakes a waiter with no timer firing, and publishes only when someone may be waiting', async () => {
    fakeAllTimers()
    const publish = vi.spyOn(appState(), 'publish')
    await withVolumeClaim(remote, { ...WAIT, paths: ['a'] }, async () => {})
    expect(publish).not.toHaveBeenCalled()

    const holder = change(['a'])
    await holder.entered
    const waiter = change(['a'])
    // Let it reach its first pause; from here on no timer is advanced.
    await vi.advanceTimersByTimeAsync(1)
    holder.finish(); await holder.done
    await waiter.entered
    expect(publish).toHaveBeenCalledTimes(1)
    waiter.finish(); await waiter.done
  })
})
