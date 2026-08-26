/**
 * Read-cost contract for the messages page reader.
 *
 * The rest of the page suite asserts what getSessionMessagesPage RETURNS. This
 * file asserts what it COSTS: how many bytes it pulls off disk to return it.
 *
 * That distinction is the whole point. The regression this endpoint was
 * rewritten for — a page read that materialized the entire transcript, twice —
 * produced completely correct pages. Every behavioural test stayed green while
 * a 15MB session read tens of MB per refetch and pushed the container into OOM.
 * Only an assertion on bytes-read can fail on that.
 *
 * The contract in one line: a trailing page costs O(window), not O(transcript).
 * Cursor pages are the documented exception — the backward scan cannot stop at
 * the first occurrence of the cursor id, because a replayed duplicate row
 * shares its uuid and the deepest occurrence is the real anchor, so the scan
 * always walks to the start of the file. The bound that matters there is that
 * it walks it ONCE (see the offset-carrying-cursor note on MAX_TAIL_LINES).
 *
 * Accounting patches fs.promises.open to wrap handle.read, which both readers
 * bottom out in — the backward index scan calls it directly, and the forward
 * window read reaches it through createReadStream. Wrapping createReadStream
 * as well would double-count every byte of the window.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { getSessionMessagesPage } from './session-service'

const KB = 1024
const MB = 1024 * KB
const AGENT = 'cost-agent'
/** The window a cursor page extends past its anchor (CURSOR_WINDOW_GRACE_BYTES). */
const CURSOR_GRACE = 512 * KB
/** Slack for where the 64KB backward-walk chunks happen to land. */
const CHUNK_SLACK = 128 * KB

let testDir: string
let originalDataDir: string | undefined

beforeEach(async () => {
  testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-cost-'))
  originalDataDir = process.env.SUPERAGENT_DATA_DIR
  process.env.SUPERAGENT_DATA_DIR = testDir
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (originalDataDir) process.env.SUPERAGENT_DATA_DIR = originalDataDir
  else delete process.env.SUPERAGENT_DATA_DIR
  await fs.promises.rm(testDir, { recursive: true, force: true })
})

interface ReadAccount {
  /** Bytes actually delivered from disk. */
  bytes: number
  /** Read round-trips — on a network filesystem each one is priced separately. */
  reads: number
}

function trackReads(): ReadAccount {
  const account: ReadAccount = { bytes: 0, reads: 0 }
  const realOpen = fs.promises.open.bind(fs.promises)

  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...(args as Parameters<typeof realOpen>))
    const realRead = handle.read.bind(handle)
    handle.read = (async (...readArgs: unknown[]) => {
      const result = await realRead(...(readArgs as Parameters<typeof realRead>))
      account.reads++
      account.bytes += result.bytesRead
      return result
    }) as typeof handle.read
    return handle
  })

  return account
}

/** Measure one page read in isolation, leaving no mock behind. */
async function costOf(
  sessionId: string,
  opts: Parameters<typeof getSessionMessagesPage>[2]
): Promise<{ account: ReadAccount; page: Awaited<ReturnType<typeof getSessionMessagesPage>> }> {
  const account = trackReads()
  try {
    const page = await getSessionMessagesPage(AGENT, sessionId, opts)
    return { account, page }
  } finally {
    vi.restoreAllMocks()
  }
}

/** One user/assistant exchange, padded to a controllable row size. */
function turn(index: number, padBytes: number): object[] {
  return [
    {
      type: 'user',
      uuid: `u-${index}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2)).toISOString(),
      sessionId: 'cost-session',
      parentUuid: null,
      message: { role: 'user', content: `q${index}` },
    },
    {
      type: 'assistant',
      uuid: `a-${index}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2 + 1)).toISOString(),
      sessionId: 'cost-session',
      parentUuid: `u-${index}`,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `a${index} ${'x'.repeat(padBytes)}` }],
      },
    },
  ]
}

function thread(turns: number, padBytes: number): object[] {
  return Array.from({ length: turns }, (_, i) => turn(i, padBytes)).flat()
}

async function writeTranscript(sessionId: string, entries: object[]): Promise<number> {
  const sessionsDir = path.join(
    testDir, 'agents', AGENT, 'workspace', '.claude', 'projects', '-workspace'
  )
  await fs.promises.mkdir(sessionsDir, { recursive: true })
  const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`)
  await fs.promises.writeFile(jsonlPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return fs.statSync(jsonlPath).size
}

describe('messages page read cost — trailing page', () => {
  it('reads a small constant, not the transcript, for the first page', async () => {
    // 4MB of history behind a 20-item page.
    const size = await writeTranscript('cost-session', thread(1500, 2600))
    expect(size).toBeGreaterThan(4 * MB)

    const { account, page } = await costOf('cost-session', { limit: 20 })

    expect(page.messages).toHaveLength(20)
    // Measured ~96KB: one backward chunk to find the window, then the window
    // itself. A page that costs anything approaching the file is the
    // regression this bound exists to catch.
    expect(account.bytes).toBeLessThan(512 * KB)
    expect(account.bytes).toBeLessThan(size / 8)
    // And in a handful of round-trips, not a walk over the whole file.
    expect(account.reads).toBeLessThan(10)
  })

  it('costs the same against 4MB of history as against 200KB', async () => {
    // Identical trailing turns; the transcripts differ only in what sits above.
    const shallowSize = await writeTranscript('shallow', thread(80, 2600))
    const deepSize = await writeTranscript('deep', thread(1500, 2600))
    expect(deepSize).toBeGreaterThan(shallowSize * 10)

    const shallow = await costOf('shallow', { limit: 20 })
    const deep = await costOf('deep', { limit: 20 })

    // The read-amplification pin, and the one that fails loudest on a
    // regression: 20x the history must not cost measurably more. Slack covers
    // where the backward walk's chunk boundaries land, nothing more.
    expect(deep.account.bytes).toBeLessThanOrEqual(shallow.account.bytes + CHUNK_SLACK)
    expect(deep.page.messages).toHaveLength(20)
  })

  it('never materializes a huge row that sits outside the window', async () => {
    // The transcript opens with a single 6MB row — an old turn that embedded a
    // large payload. A trailing page must not pay for it.
    const size = await writeTranscript('huge-head', [...turn(0, 6 * MB), ...thread(40, 800)])
    expect(size).toBeGreaterThan(6 * MB)

    const { account, page } = await costOf('huge-head', { limit: 10 })

    expect(page.messages).toHaveLength(10)
    expect(account.bytes).toBeLessThan(512 * KB)
  })
})

describe('messages page read cost — bounded window', () => {
  it('keeps the read within a small multiple of the budget when it truncates the page', async () => {
    const size = await writeTranscript('budgeted', thread(1500, 2600))
    expect(size).toBeGreaterThan(4 * MB)

    const byteBudget = 256 * KB
    const { account, page } = await costOf('budgeted', { limit: 2000, byteBudget })

    // A 2000-item request against a budget that fits far fewer: the page comes
    // back short with a cursor rather than growing the window to fit.
    expect(page.messages.length).toBeGreaterThan(0)
    expect(page.messages.length).toBeLessThan(2000)
    expect(page.nextCursor).toBe(page.messages[0]!.id)
    // The window is capped at 2x the budget and is covered twice — once by the
    // scan, once by the read.
    expect(account.bytes).toBeLessThan(byteBudget * 4)
  })

  it('pays for an oversized trailing row twice, and for nothing else', async () => {
    // A single 2MB row as the newest turn, against a 64KB budget. The budget
    // yields to it — an empty page would strand the session — so the row is
    // scanned once to classify it and read once to serve it. That O(largest
    // row) term is the documented per-request bound; what must NOT happen is
    // the rest of the transcript coming along with it.
    const size = await writeTranscript('fat-tail', [...thread(30, 800), ...turn(99, 2 * MB)])

    const { account, page } = await costOf('fat-tail', { limit: 10, byteBudget: 64 * KB })

    expect(page.messages.length).toBeGreaterThan(0)
    expect(account.bytes).toBeLessThan(size * 2 + CHUNK_SLACK)
  })
})

describe('messages page read cost — cursor pages', () => {
  // A cursor page cannot stop at the first match: a replayed duplicate row
  // carries the same uuid, and the transform anchors on the deepest occurrence,
  // so the scan walks to the start of the file by design. These tests pin that
  // it walks it once — the double-full-read regression showed up here first.

  it('traverses the transcript once for a cursor at the very start', async () => {
    const size = await writeTranscript('deep-cursor', thread(600, 2600))
    expect(size).toBeGreaterThan(1 * MB)

    const { account, page } = await costOf('deep-cursor', { limit: 10, cursor: 'u-5' })

    expect(page.messages.length).toBeGreaterThan(0)
    expect(account.bytes).toBeLessThan(size + CURSOR_GRACE + CHUNK_SLACK)
  })

  it('traverses it once for a cursor at the very end', async () => {
    const size = await writeTranscript('shallow-cursor', thread(600, 2600))

    const { account, page } = await costOf('shallow-cursor', { limit: 5, cursor: 'u-599' })

    expect(page.messages).toHaveLength(5)
    // The window here is a handful of rows, so the whole cost is the scan.
    expect(account.bytes).toBeLessThan(size + CHUNK_SLACK)
  })

  it('gives up on a vanished cursor after one traversal, with no window read', async () => {
    const size = await writeTranscript('no-such-cursor', thread(600, 2600))

    const { account, page } = await costOf('no-such-cursor', {
      limit: 10,
      cursor: 'not-a-real-uuid',
    })

    expect(page).toEqual({ messages: [], nextCursor: null })
    // Nothing to serve means nothing to read: the search ends at the start of
    // the file and no window is materialized.
    expect(account.bytes).toBeLessThan(size + CHUNK_SLACK)
  })
})
