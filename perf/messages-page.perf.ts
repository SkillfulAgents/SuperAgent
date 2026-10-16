/**
 * The chat transcript: `GET /api/agents/:id/sessions/:sessionId/messages` on a
 * long tool-heavy session (~22 MB), the read every chat open, reconnect,
 * foreground and periodic refresh makes, plus the older page behind it and
 * the live delta.
 *
 * Two things are pinned here. Reads: a backward walk of a long transcript is
 * a chain of dependent reads (each one an RPC on a network volume, with no
 * readahead to hide it), so their number is what a page costs in wall time.
 * And bytes: a trailing page costs its window, not the transcript; an older
 * page walks the transcript once (the cursor's deepest occurrence is the
 * anchor, so the scan always reaches the start).
 *
 * `max_bytes` is what the clients send: iOS 512 KiB for the latest page and
 * 1 MiB for "Load Earlier", the web 1 MiB for its trailing page. No
 * `max_bytes` is every client that predates it, served the default 4 MiB
 * window exactly as before.
 *
 * Before (fixed 64 KiB reads, no `max_bytes`; a 512 KiB request then got the
 * default window too): trailing page 139 ops / 133 reads / 8.6 MB read; older
 * page 407 / 402 / 26.3 MB; delta 36 / 31 / 2.0 MB.
 *
 * Op counts are pinned exactly; wall budgets are ~2× the recorded value at
 * BUDGET_LATENCY_MS (see harness.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootPerfApp, expectWithinBudget, measure, type Measurement, type PerfApp } from './harness'

interface PageBody {
  messages: { id: string }[]
  nextCursor: string | null
}

interface DeltaBody {
  messages: { id: string }[]
  anchor: string | null
  resync?: true
}

const KiB = 1024
const MiB = 1024 * KiB

describe('chat transcript — long session', () => {
  let perf: PerfApp
  let url: string
  let newest: string

  beforeAll(async () => {
    perf = await bootPerfApp('transcript')
    const long = perf.seeded.longSession!
    expect(long.bytes).toBeGreaterThan(16 * MiB)
    url = `/api/agents/${long.agentSlug}/sessions/${long.sessionId}/messages`
    newest = long.newestItemId
    // Unmeasured: the actor's first containment check resolves the workspace
    // root once per process. Paid here so no scenario's count depends on
    // running first.
    expect((await perf.request(`${url}?limit=1`)).status).toBe(200)
  })

  afterAll(async () => {
    await perf?.dispose()
  })

  /** One measured request; the response is read outside the measurement. */
  async function read<T>(query: string): Promise<{ body: T; measurement: Measurement; responseBytes: number }> {
    const { result, measurement } = await measure(() => perf.request(`${url}?${query}`))
    expect(result.status).toBe(200)
    const text = await result.text()
    let body: T
    try {
      body = JSON.parse(text) as T
    } catch {
      return expect.fail(`${query}: the response is not JSON`)
    }
    return { body, measurement, responseBytes: Buffer.byteLength(text) }
  }

  /** The payload a client downloads and decodes, next to the [perf] line. */
  function reportPayload(label: string, responseBytes: number, items: number): void {
    process.stdout.write(`       payload ${label}: response=${responseBytes}B items=${items}\n`)
  }

  /** The unmeasured trailing page a client holds before it asks for more. */
  async function latest(query: string): Promise<PageBody> {
    const res = await perf.request(`${url}?${query}`)
    expect(res.status).toBe(200)
    return (await res.json()) as PageBody
  }

  function expectTrailingPage(body: PageBody): void {
    expect(body.messages.length).toBeGreaterThan(0)
    expect(body.messages.at(-1)!.id).toBe(newest)
    // More history than any one page: the cursor names the page's first item.
    expect(body.nextCursor).toBe(body.messages[0]!.id)
  }

  function expectOlderPage(body: PageBody, first: PageBody): void {
    expect(body.messages.length).toBeGreaterThan(0)
    // Ends right before the page it extends, without overlapping it.
    const shown = new Set(first.messages.map((m) => m.id))
    expect(body.messages.some((m) => shown.has(m.id))).toBe(false)
    expect(body.nextCursor).toBe(body.messages[0]!.id)
  }

  it('trailing page, no max_bytes (clients that predate it)', async () => {
    const { body, measurement, responseBytes } = await read<PageBody>('limit=300&media=ref')
    expectTrailingPage(body)
    reportPayload('default budget', responseBytes, body.messages.length)
    expectWithinBudget('transcript: trailing page (default budget)', measurement, {
      totalOps: 19,
      ops: { 'handle.read': 14 },
      bytesRead: 9_455_210,
      wallMs: 650,
    })
  })

  it('trailing page, max_bytes=512KiB (iOS latest page)', async () => {
    const { body, measurement, responseBytes } = await read<PageBody>(`limit=300&media=ref&max_bytes=${512 * KiB}`)
    expectTrailingPage(body)
    // Soft budget: the window closes the merge group it lands in, never more
    // than the 2× hard cap.
    expect(responseBytes).toBeLessThan(2 * 512 * KiB)
    reportPayload('max_bytes 512KiB', responseBytes, body.messages.length)
    expectWithinBudget('transcript: trailing page (max_bytes 512KiB)', measurement, {
      totalOps: 11,
      ops: { 'handle.read': 6 },
      bytesRead: 1_532_367,
      wallMs: 300,
    })
  })

  it('trailing page, max_bytes=1MiB (web trailing page)', async () => {
    const { body, measurement, responseBytes } = await read<PageBody>(`limit=300&media=ref&max_bytes=${MiB}`)
    expectTrailingPage(body)
    expect(responseBytes).toBeLessThan(2 * MiB)
    reportPayload('max_bytes 1MiB', responseBytes, body.messages.length)
    expectWithinBudget('transcript: trailing page (max_bytes 1MiB)', measurement, {
      totalOps: 13,
      ops: { 'handle.read': 8 },
      bytesRead: 3_113_696,
      wallMs: 320,
    })
  })

  it('older page, no max_bytes', async () => {
    const first = await latest('limit=300&media=ref')
    const { body, measurement, responseBytes } = await read<PageBody>(
      `limit=200&media=ref&cursor=${encodeURIComponent(first.nextCursor!)}`,
    )
    expectOlderPage(body, first)
    reportPayload('older, default budget', responseBytes, body.messages.length)
    expectWithinBudget('transcript: older page (default budget)', measurement, {
      totalOps: 34,
      ops: { 'handle.read': 29 },
      bytesRead: 26_295_748,
      wallMs: 1100,
    })
  })

  it('older page, max_bytes=1MiB (iOS Load Earlier)', async () => {
    const first = await latest(`limit=300&media=ref&max_bytes=${512 * KiB}`)
    const { body, measurement, responseBytes } = await read<PageBody>(
      `limit=200&media=ref&max_bytes=${MiB}&cursor=${encodeURIComponent(first.nextCursor!)}`,
    )
    expectOlderPage(body, first)
    expect(responseBytes).toBeLessThan(2 * MiB)
    reportPayload('older, max_bytes 1MiB', responseBytes, body.messages.length)
    expectWithinBudget('transcript: older page (max_bytes 1MiB)', measurement, {
      totalOps: 32,
      ops: { 'handle.read': 27 },
      bytesRead: 23_147_079,
      wallMs: 900,
    })
  })

  it('forward delta after the newest settled item', async () => {
    const { body, measurement, responseBytes } = await read<DeltaBody>(
      `limit=300&media=ref&after=${encodeURIComponent(newest)}`,
    )
    expect(body.resync).toBeUndefined()
    expect(body.messages.map((m) => m.id)).toContain(newest)
    reportPayload('delta', responseBytes, body.messages.length)
    expectWithinBudget('transcript: forward delta', measurement, {
      totalOps: 10,
      ops: { 'handle.read': 5 },
      bytesRead: 2_031_616,
      wallMs: 340,
    })
  })
})
