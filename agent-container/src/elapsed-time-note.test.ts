import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElapsedNote, elapsedTimeNote, formatElapsed, lastTranscriptActivity } from './elapsed-time-note'

const line = (entry: object) => JSON.stringify(entry)

describe('lastTranscriptActivity', () => {
  it.each([
    ['assistant', '2026-09-10T11:00:00.000Z', 'user', '2026-09-10T10:30:00.000Z'],
    ['user', '2026-09-10T11:00:00.000Z', 'assistant', '2026-09-10T10:30:00.000Z'],
  ])('takes the newest stamp when a %s entry is newest, regardless of line order', (newestType, newest, olderType, older) => {
    const tail = [
      'ssistant","timestamp":"2026-09-10T10:00:00.000Z"}',
      line({ type: newestType, timestamp: newest }),
      line({ type: olderType, timestamp: older }),
      line({ type: 'attachment', timestamp: '2026-09-10T12:00:00.000Z' }),
      line({ type: 'last-prompt' }),
      line({ type: 'queue-operation', timestamp: '2026-09-10T13:00:00.000Z' }),
    ].join('\n')
    expect(lastTranscriptActivity(tail)?.toISOString()).toBe(newest)
  })

  it('returns null when no message entry carries a timestamp', () => {
    expect(lastTranscriptActivity([line({ type: 'attachment' }), 'null', 'not json', ''].join('\n'))).toBeNull()
  })
})

describe('formatElapsed', () => {
  it.each([
    [23 * 60_000, '23m'],
    [2 * 3_600_000, '2h'],
    [(2 * 60 + 13) * 60_000, '2h 13m'],
    [(24 + 22) * 3_600_000 + 59_000, '1 day 22h'],
    [3 * 24 * 3_600_000, '3 days'],
    [12 * 24 * 3_600_000 + 5 * 3_600_000, '12 days'],
  ])('%i ms → %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected)
  })
})

describe('buildElapsedNote', () => {
  it('renders both moments in the zone and the elapsed figure', () => {
    const note = buildElapsedNote(
      new Date('2026-09-09T01:40:00Z'),
      new Date('2026-09-10T23:52:00Z'),
      'America/Los_Angeles',
    )
    expect(note).toBe(
      'The previous message was Tuesday, 2026-09-08 18:40. It is now Thursday, 2026-09-10 16:52 (America/Los_Angeles), 1 day 22h later.',
    )
  })
})

describe('elapsedTimeNote', () => {
  const now = new Date('2026-09-10T23:52:00Z')
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'elapsed-note-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  const transcriptWith = async (lastAt: string) => {
    const file = join(dir, 'session.jsonl')
    await writeFile(file, [line({ type: 'user', timestamp: '2026-09-01T00:00:00Z' }), line({ type: 'assistant', timestamp: lastAt })].join('\n') + '\n')
    return file
  }

  it('is null for a transcript that does not exist yet', async () => {
    expect(await elapsedTimeNote('/nonexistent/session.jsonl', now, 'UTC')).toBeNull()
  })

  it('is null under the threshold', async () => {
    expect(await elapsedTimeNote(await transcriptWith('2026-09-10T23:38:00Z'), now, 'UTC')).toBeNull()
  })

  it('states the gap at or past the threshold', async () => {
    expect(await elapsedTimeNote(await transcriptWith('2026-09-10T23:37:00Z'), now, 'UTC')).toBe(
      'The previous message was Thursday, 2026-09-10 23:37. It is now Thursday, 2026-09-10 23:52 (UTC), 15m later.',
    )
  })
})
