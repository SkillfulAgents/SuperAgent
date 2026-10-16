import { test, expect, type Page, type Response } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { createAgent, createSession, uniqueName } from '../helpers/agents'

/**
 * Scroll-up pagination, end to end.
 *
 * The server pages the transcript and the client walks it backwards, but until
 * now nothing exercised the two together in a browser. The unit tests cover
 * each half in isolation: the reader returns a page and a cursor, the hook
 * merges a prepend. What only shows up in a real viewport is the seam — that
 * the first load stops at the trailing page instead of pulling the whole
 * session, that reaching the top actually asks for more, that the content the
 * reader was looking at does not jump when older messages land above it, and
 * that walking back to the beginning ends rather than looping on a cursor that
 * never resolves.
 *
 * History is seeded by writing rows into the session's JSONL directly. Sending
 * 400 messages through the UI would take minutes and prove nothing extra — the
 * point is a transcript longer than one page, not how it got that way.
 *
 * Agents are left behind for the next setup-e2e-data run rather than deleted,
 * matching navigation.spec.ts: this suite runs fully parallel against a
 * file-backed store, and deleting mid-run races siblings scanning session files.
 */

const E2E_DATA_DIR = path.resolve(process.cwd(), process.env.SUPERAGENT_DATA_DIR ?? '.e2e-data')

/** Server-side first-page size (MESSAGES_PAGE_LIMIT), and the client's initial render window. */
const PAGE_LIMIT = 300
/** 400 seeded items under a ~402-item transcript: two pages, no third. */
const HISTORY_TURNS = 200
const HISTORY_ITEMS = HISTORY_TURNS * 2

/** Zero-padded so `turn 001` is never a substring match for `turn 010`. */
const historyUserText = (i: number) => `history turn ${String(i).padStart(3, '0')}`
const historyReplyText = (i: number) => `history reply ${String(i).padStart(3, '0')}`

const OLDEST = historyUserText(0)
const NEWEST = historyReplyText(HISTORY_TURNS - 1)

function sessionJsonlPath(agentSlug: string, sessionId: string): string {
  return path.join(
    E2E_DATA_DIR, 'agents', agentSlug, 'workspace', '.claude', 'projects', '-workspace',
    `${sessionId}.jsonl`
  )
}

/**
 * Prepend HISTORY_ITEMS display items ahead of the session's real turn, so the
 * live edge stays the message the session was actually created with and
 * everything above it has to be paged to.
 */
function seedHistory(agentSlug: string, sessionId: string): void {
  const jsonlPath = sessionJsonlPath(agentSlug, sessionId)
  const existing = fs.readFileSync(jsonlPath, 'utf-8')
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString()

  const rows: string[] = []
  for (let i = 0; i < HISTORY_TURNS; i++) {
    rows.push(JSON.stringify({
      type: 'user',
      uuid: `hist-u-${i}`,
      timestamp: at(i * 2),
      sessionId,
      parentUuid: null,
      message: { role: 'user', content: historyUserText(i) },
    }))
    rows.push(JSON.stringify({
      type: 'assistant',
      uuid: `hist-a-${i}`,
      timestamp: at(i * 2 + 1),
      sessionId,
      parentUuid: `hist-u-${i}`,
      message: { role: 'assistant', content: [{ type: 'text', text: historyReplyText(i) }] },
    }))
  }

  fs.writeFileSync(jsonlPath, `${rows.join('\n')}\n${existing}`)
}

interface PageResponse {
  cursor: string | null
  count: number
  nextCursor: string | null
}

/** Split a URL without `new URL`, which the lint rules treat as throwing. */
function splitUrl(url: string): { path: string; params: URLSearchParams } {
  const [path = '', query = ''] = url.split('?')
  return { path, params: new URLSearchParams(query) }
}

function isOlderPageRequest(url: string): boolean {
  const { path, params } = splitUrl(url)
  return path.endsWith('/messages') && params.get('cursor') !== null
}

/** Record every /messages page response, keeping the cursor it was asked with. */
function trackMessagePages(page: Page): PageResponse[] {
  const seen: PageResponse[] = []
  page.on('response', (response: Response) => {
    const { path, params } = splitUrl(response.url())
    if (!path.endsWith('/messages')) return
    if (params.get('after') !== null) return // forward delta, not a page
    void response
      .json()
      .then((body: { messages?: unknown[]; nextCursor?: string | null }) => {
        if (!Array.isArray(body?.messages)) return
        seen.push({
          cursor: params.get('cursor'),
          count: body.messages.length,
          nextCursor: body.nextCursor ?? null,
        })
      })
      .catch(() => {
        // Aborted/superseded refetch — nothing to record.
      })
  })
  return seen
}

/** Two painted frames: long enough for a prepend's scroll restore to land. */
async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
}

function messageListMetrics(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="message-list"]')!
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  })
}

async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector('[data-testid="message-list"]')!.scrollTo({ top: 0 })
  })
}

/** Create a session, wait for its transcript to land, then bury it under history. */
async function seededSession(
  request: Parameters<typeof createSession>[0],
  agent: { slug: string },
): Promise<{ id: string }> {
  const session = await createSession(request, agent, 'seed the transcript')
  await expect
    .poll(() => fs.existsSync(sessionJsonlPath(agent.slug, session.id)), { timeout: 15_000 })
    .toBe(true)
  seedHistory(agent.slug, session.id)
  return session
}

test.describe('transcript pagination', () => {
  test('first load serves the trailing page, not the whole transcript', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(90_000)
    const agent = await createAgent(request, uniqueName(testInfo, 'Pagination First'))
    const session = await seededSession(request, agent)

    const pages = trackMessagePages(page)
    await page.goto(`/agents/${agent.slug}/sessions/${session.id}`)

    // The newest seeded item is at the live edge and renders immediately.
    await expect(page.getByText(NEWEST, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => pages.length, { timeout: 15_000 }).toBeGreaterThan(0)

    const first = pages.find((p) => p.cursor === null)!
    // Capped at one page even though ~402 items exist, and the cursor says
    // there is more behind it. Serving the whole transcript here is the
    // regression this asserts against.
    expect(first.count).toBe(PAGE_LIMIT)
    expect(first.nextCursor).not.toBeNull()

    // History older than the trailing page is not in the DOM at all — not
    // hidden by CSS, not rendered off-screen.
    await expect(page.getByText(OLDEST, { exact: true })).toHaveCount(0)
  })

  test('scrolling to the top pages back to the start and stops there', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const agent = await createAgent(request, uniqueName(testInfo, 'Pagination Walk'))
    const session = await seededSession(request, agent)

    const pages = trackMessagePages(page)
    await page.goto(`/agents/${agent.slug}/sessions/${session.id}`)
    await expect(page.getByText(NEWEST, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => pages.length, { timeout: 15_000 }).toBeGreaterThan(0)

    // Walk backwards until the very first message is reachable, bounding the
    // loop so a cursor that never resolves fails instead of hanging.
    const userMessages = page.locator('[data-testid="message-user"]')
    let anchorShift = 0
    let anchorsMeasured = 0
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await page.getByText(OLDEST, { exact: true }).count()) break

      const renderedBefore = await userMessages.count()
      // A handle to the node sitting at the top of the viewport, not a locator:
      // after the prepend `.first()` would resolve to a different element, and
      // it is THIS one whose position must not move.
      const anchor = await userMessages.first().elementHandle()
      await scrollToTop(page)
      const before = await anchor?.boundingBox()

      const pagesBefore = pages.length
      await expect.poll(() => pages.length, { timeout: 20_000 }).toBeGreaterThan(pagesBefore)
      // The prepend is only real once the older rows are in the DOM.
      await expect
        .poll(() => userMessages.count(), { timeout: 20_000 })
        .toBeGreaterThan(renderedBefore)
      await settleFrames(page)

      const after = await anchor?.boundingBox()
      if (before && after) {
        anchorsMeasured++
        anchorShift = Math.max(anchorShift, Math.abs(after.y - before.y))
      }
    }

    // Reached the beginning of the transcript.
    await expect(page.getByText(OLDEST, { exact: true })).toHaveCount(1)

    const olderPages = pages.filter((p) => p.cursor !== null)
    expect(olderPages.length).toBeGreaterThan(0)
    // Every older page carried content: an empty one would let the client spin
    // on the same cursor forever.
    for (const olderPage of olderPages) expect(olderPage.count).toBeGreaterThan(0)
    // The walk ended because the server said there was nothing older, not
    // because the loop ran out of attempts.
    expect(olderPages[olderPages.length - 1]!.nextCursor).toBeNull()

    // The reader's place was held across each prepend. Some movement is
    // expected — the restore lands a frame behind the DOM growth — but the
    // viewport must not be thrown to a different part of the transcript.
    expect(anchorsMeasured).toBeGreaterThan(0)
    expect(anchorShift).toBeLessThan(150)

    // At the start of history with nothing left to fetch, further scroll-ups
    // must not keep asking. Waiting on the network for a request that must
    // never arrive, rather than on the clock.
    await scrollToTop(page)
    await expect(
      page.waitForResponse((response) => isOlderPageRequest(response.url()), { timeout: 3_000 })
    ).rejects.toThrow()

    // And the transcript is still whole and scrollable.
    await expect(page.getByText(OLDEST, { exact: true })).toBeVisible()
    const metrics = await messageListMetrics(page)
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
  })

  // Guards the fixture's own arithmetic: if the seed ever stops exceeding one
  // page, both tests above would pass while asserting nothing.
  test('the seeded transcript is longer than a single page', () => {
    expect(HISTORY_ITEMS).toBeGreaterThan(PAGE_LIMIT)
  })
})
