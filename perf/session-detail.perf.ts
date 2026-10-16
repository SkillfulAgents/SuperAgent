/**
 * The single-session read, `GET /api/agents/:id/sessions/:sid`: iOS fires it on
 * every chat open and after every turn, the web on session open and on every
 * `session_updated`. It reports what the session list reports (metadata plus
 * one stat of the transcript), so its cost must not grow with the transcript.
 * The session read here gets a large transcript and the budgets pin
 * `bytesRead` at 0: a return to parsing the transcript (SUP-1182) reads every
 * byte of it. `PATCH` rename answers with the same read.
 *
 * Small profile. Op counts are pinned exactly; wall budgets are ~2× the
 * recorded value at BUDGET_LATENCY_MS (see harness.ts).
 */
import * as fs from 'fs'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootPerfApp, expectWithinBudget, measure, type PerfApp } from './harness'

const LARGE_TRANSCRIPT_BYTES = 10 * 1024 * 1024

/** User/assistant pairs of ~64KB each until the file passes `bytes`. */
function largeTranscript(sessionId: string, bytes: number): string {
  const lines: string[] = []
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const timestamp = new Date(Date.UTC(2025, 11, 1) + i * 1000).toISOString()
    const line = i % 2 === 0
      ? JSON.stringify({ type: 'user', uuid: `${sessionId}-u${i}`, sessionId, timestamp, message: { role: 'user', content: `Question ${i}` } })
      : JSON.stringify({
          type: 'assistant',
          uuid: `${sessionId}-a${i}`,
          sessionId,
          timestamp,
          message: { id: `msg_${i}`, role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(64 * 1024) }] },
        })
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n') + '\n'
}

describe('single-session read — small profile', () => {
  let perf: PerfApp
  let slug: string
  let sessionId: string

  beforeAll(async () => {
    perf = await bootPerfApp('small')
    slug = perf.seeded.agentSlugs[0]!
    sessionId = perf.seeded.latestVisibleByAgent[slug]!
    const file = path.join(perf.seeded.dataDir, 'agents', slug, 'workspace', '.claude', 'projects', '-workspace', `${sessionId}.jsonl`)
    const { mtime } = await fs.promises.stat(file)
    await fs.promises.writeFile(file, largeTranscript(sessionId, LARGE_TRANSCRIPT_BYTES))
    await fs.promises.utimes(file, mtime, mtime)
  })

  afterAll(async () => {
    await perf?.dispose()
  })

  it('GET /api/agents/:id/sessions/:sid on a large transcript', async () => {
    await perf.request('/api/agents')
    const listed = await (await perf.request(`/api/agents/${slug}/sessions`)).json()
    const { result, measurement } = await measure(() => perf.request(`/api/agents/${slug}/sessions/${sessionId}`))
    expect(result.status).toBe(200)
    const body = await result.json()
    // Correctness on a real filesystem: the detail agrees with the list.
    const inList = listed.find((s: { id: string }) => s.id === sessionId)
    expect(body).toMatchObject({ id: sessionId, name: inList.name, createdAt: inList.createdAt, lastActivityAt: inList.lastActivityAt })
    expect(body).not.toHaveProperty('messageCount')
    // Was 168 ops (162 handle.read), 10.5MB read and ~1.7s: the whole transcript
    // streamed for a count no client read, plus a second metadata read.
    expectWithinBudget('small: GET session (10MB transcript)', measurement, {
      totalOps: 4,
      ops: { realpath: 2, stat: 1, readFile: 1 },
      bytesRead: 0,
      wallMs: 100,
    })
  })

  it('PATCH /api/agents/:id/sessions/:sid (rename) on a large transcript', async () => {
    const { result, measurement } = await measure(async () =>
      perf.app.request(`http://localhost/api/agents/${slug}/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      }),
    )
    expect(result.status).toBe(200)
    const body = await result.json()
    expect(body).toMatchObject({ id: sessionId, name: 'Renamed' })
    expect(body).not.toHaveProperty('messageCount')
    // Was 173 ops (162 handle.read), 10.5MB read and ~1.8s.
    expectWithinBudget('small: PATCH session rename (10MB transcript)', measurement, {
      totalOps: 10,
      ops: { stat: 2, readFile: 2, open: 2, realpath: 2, lstat: 1, rename: 1 },
      bytesRead: 0,
      wallMs: 230,
    })
  })
})
