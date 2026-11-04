import { describe, expect, it } from 'vitest'
import { latestSummaryFiles, parseSyncSummary, summaryLink } from './team-brain-syncs'

const SUMMARY = `---
type: team-brain-sync
at: 2026-10-23T03:00:00-07:00
session: s-123
sources: [slack, notion]
added: 3
updated: 9
---
## Highlights
### Acme's renewal moves to Q1
Acme asked to move it.
[Acme Corp](../../customers/acme.md) has the date.

### Launch plan
The brief landed.

## Changes
- Cycle 14 closed; [Roadmap](../../product/roadmap.md) marks it.
- Four new bugs.

## Needs you
### Blocked
- Reconnect Slack. #sales and #eng were not read this run.
### To decide
- Is Acme's renewal Q1 or Q2? Two threads disagree. Filed as Q1.
`

describe('parseSyncSummary', () => {
  it('reads the header and every section', () => {
    expect(parseSyncSummary('_brain/syncs/2026-10-23 0300.md', SUMMARY)).toEqual({
      id: '_brain/syncs/2026-10-23 0300.md',
      at: '2026-10-23T03:00:00-07:00',
      session: 's-123',
      sources: ['slack', 'notion'],
      added: 3,
      updated: 9,
      highlights: [
        { title: "Acme's renewal moves to Q1", body: 'Acme asked to move it.\n[Acme Corp](../../customers/acme.md) has the date.' },
        { title: 'Launch plan', body: 'The brief landed.' },
      ],
      changes: '- Cycle 14 closed; [Roadmap](../../product/roadmap.md) marks it.\n- Four new bugs.',
      needsYou: {
        blocked: '- Reconnect Slack. #sales and #eng were not read this run.',
        toDecide: "- Is Acme's renewal Q1 or Q2? Two threads disagree. Filed as Q1.",
      },
    })
  })

  it('reads a quiet run with only its header', () => {
    expect(parseSyncSummary('q', '---\ntype: team-brain-sync\nat: 2026-10-24T03:00:00-07:00\nsession: s-9\nadded: 0\nupdated: 0\n---\n')).toMatchObject({
      session: 's-9', sources: [], added: 0, updated: 0, highlights: [], changes: '', needsYou: { blocked: '', toDecide: '' },
    })
  })
  it('reads lines under no heading in Needs you as to decide, as summaries before the split wrote them', () => {
    expect(parseSyncSummary('o', '---\ntype: team-brain-sync\nat: 2026-10-22T03:00:00-07:00\n---\n## Needs you\n- Reconnect Slack.\n### To decide\n- Q1 or Q2?\n')?.needsYou).toEqual({
      blocked: '',
      toDecide: '- Reconnect Slack.\n\n- Q1 or Q2?',
    })
  })

  it('keeps each part as written: indentation, and a heading with nothing under it', () => {
    const sync = parseSyncSummary('k', '---\ntype: team-brain-sync\nat: 2026-10-22T03:00:00-07:00\n---\n## Highlights\n### Launch plan\n## Changes\n\n    npm run build\n')
    expect(sync).toMatchObject({ highlights: [{ title: 'Launch plan', body: '' }], changes: '\n    npm run build' })
  })

  it('reads what agents and editors write loosely: CRLF lines, bad counts, repeated sources', () => {
    const sync = parseSyncSummary('w', '---\r\ntype: team-brain-sync\r\nat: 2026-10-23T00:00:00-07:00\r\nsources: [slack, slack]\r\nadded: two\r\nupdated: -1\r\n---\r\n## Changes\r\n* Starred.\r\n')
    expect(sync).toMatchObject({ sources: ['slack'], added: 0, updated: 0, changes: '* Starred.' })
  })

  it('reads no more than a run could have meant: no endless counts, and a time only with its offset', () => {
    const header = (at: string) => `---\ntype: team-brain-sync\nat: ${at}\nadded: Infinity\n---\n`
    expect(parseSyncSummary('i', header('2026-10-23T00:00:00Z'))).toMatchObject({ added: 0 })
    expect(parseSyncSummary('t', header('2026-10-23T00:00:00'))).toBeNull()
  })

  it('links the run only from an id, never from a placeholder', () => {
    const at = (session: string) => parseSyncSummary('s', `---\ntype: team-brain-sync\nat: 2026-10-23T00:00:00-07:00\nsession: ${session}\n---\n`)?.session
    expect(at('526c9fe1-1f4e-47da-920a-3896e5e3c12c')).toBe('526c9fe1-1f4e-47da-920a-3896e5e3c12c')
    expect(at('<your GAMUT_SESSION_ID environment variable>')).toBeNull()
  })

  it('skips a file that is not a sync: no mark, or no time it ran', () => {
    expect(parseSyncSummary('_brain/syncs/README.md', '# Sync reports\n\n- [2026-10-23 1345](2026-10-23 1345.md)\n')).toBeNull()
    expect(parseSyncSummary('a', '---\nat: 2026-10-23T13:45:00-07:00\n---\n')).toBeNull()
    expect(parseSyncSummary('b', '---\ntype: team-brain-sync\nat: last night\n---\n')).toBeNull()
  })
})

describe('summaryLink', () => {
  const from = '_brain/syncs'
  it('reads a link as a page in the drive, a link with a scheme, or words', () => {
    expect(summaryLink('../../product/decisions/0009%20pricing.md#why', from)).toEqual({ page: 'product/decisions/0009 pricing.md' })
    expect(summaryLink('/company/overview.md', from)).toEqual({ page: 'company/overview.md' })
    expect(summaryLink('https://slack.com/x', from)).toBe('web')
    expect(summaryLink('mailto:a@b.c', from)).toBe('web')
  })

  it('reads a link leading out of the drive, or to nothing, as its words', () => {
    expect(summaryLink('../../../secrets.md', from)).toBe('text')
    expect(summaryLink('../../%2e%2e/secrets.md', from)).toBe('text')
    // The shared policy blanks a refused href before the link is drawn.
    expect(summaryLink('', from)).toBe('text')
    expect(summaryLink('#why', from)).toBe('text')
  })
})

describe('latestSummaryFiles', () => {
  it('picks the newest written markdown files, however they are named', () => {
    const file = (name: string, mtimeMs: number) => ({ name, type: 'file', mtimeMs })
    const picked = latestSummaryFiles([file('zz-old.md', 1), file('sync oct 23.md', 3), file('2026-10-22 0000.md', 2), { name: 'archive', type: 'directory', mtimeMs: 9 }, file('notes.txt', 8)], 2)
    expect(picked.map((entry) => entry.name)).toEqual(['sync oct 23.md', '2026-10-22 0000.md'])
    // A drive that gives no times (some never do) falls back to the names, newest first as the skill names them.
    expect(latestSummaryFiles([file('2026-10-21 0000.md', 0), file('2026-10-23 0000.md', 0)], 1).map((entry) => entry.name)).toEqual(['2026-10-23 0000.md'])
  })
})
