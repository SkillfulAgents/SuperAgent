import { describe, expect, it } from 'vitest'
import { latestSummaryFiles, parseSyncSummary, syncSummaryParts } from './team-brain-syncs'

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
        { title: "Acme's renewal moves to Q1", body: 'Acme asked to move it. [Acme Corp](../../customers/acme.md) has the date.' },
        { title: 'Launch plan', body: 'The brief landed.' },
      ],
      changes: ['Cycle 14 closed; [Roadmap](../../product/roadmap.md) marks it.', 'Four new bugs.'],
      needsYou: {
        blocked: ['Reconnect Slack. #sales and #eng were not read this run.'],
        toDecide: ["Is Acme's renewal Q1 or Q2? Two threads disagree. Filed as Q1."],
      },
    })
  })

  it('reads a quiet run with only its header', () => {
    expect(parseSyncSummary('q', '---\ntype: team-brain-sync\nat: 2026-10-24T03:00:00-07:00\nsession: s-9\nadded: 0\nupdated: 0\n---\n')).toMatchObject({
      session: 's-9', sources: [], added: 0, updated: 0, highlights: [], changes: [], needsYou: { blocked: [], toDecide: [] },
    })
  })
  it('reads lines under no heading in Needs you as to decide, as summaries before the split wrote them', () => {
    expect(parseSyncSummary('o', '---\ntype: team-brain-sync\nat: 2026-10-22T03:00:00-07:00\n---\n## Needs you\n- Reconnect Slack.\n')?.needsYou).toEqual({
      blocked: [],
      toDecide: ['Reconnect Slack.'],
    })
  })

  it('reads what agents and editors write loosely: CRLF lines, * bullets, bad counts, repeated sources', () => {
    const sync = parseSyncSummary('w', '---\r\ntype: team-brain-sync\r\nat: 2026-10-23T00:00:00-07:00\r\nsources: [slack, slack]\r\nadded: two\r\nupdated: -1\r\n---\r\n## Changes\r\n* Starred.\r\n+ Plussed.\r\n')
    expect(sync).toMatchObject({ sources: ['slack'], added: 0, updated: 0, changes: ['Starred.', 'Plussed.'] })
  })

  it('reads no more than a run could have meant: no blank bullets, no endless counts, and a time only with its offset', () => {
    const header = (at: string) => `---\ntype: team-brain-sync\nat: ${at}\nadded: Infinity\n---\n## Changes\n- \n-  \n- Real.\n`
    expect(parseSyncSummary('i', header('2026-10-23T00:00:00Z'))).toMatchObject({ added: 0, changes: ['Real.'] })
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

describe('syncSummaryParts', () => {
  const from = '_brain/syncs'
  it('splits a summary into words, pages in the drive and links on the web', () => {
    expect(syncSummaryParts('Filed as [Pricing](../../product/decisions/0009%20pricing.md#why) today, from [the thread](https://slack.com/x).', from)).toEqual([
      { text: 'Filed as ' },
      { page: 'product/decisions/0009 pricing.md', label: 'Pricing' },
      { text: ' today, from ' },
      { url: 'https://slack.com/x', label: 'the thread' },
      { text: '.' },
    ])
    expect(syncSummaryParts('No links here.', from)).toEqual([{ text: 'No links here.' }])
  })

  it('reads a link leading out of the drive, or to anything but the web, as its words', () => {
    expect(syncSummaryParts('[Out](../../../secrets.md) [Mail](mailto:a@b.c) [Top](/company/overview.md)', from)).toEqual([
      { text: 'Out' },
      { text: ' ' },
      { text: 'Mail' },
      { text: ' ' },
      { page: 'company/overview.md', label: 'Top' },
    ])
  })
})

it('reads an encoded way out of the drive as its words too', () => {
  expect(syncSummaryParts('[Out](../../%2e%2e/secrets.md)', '_brain/syncs')).toEqual([{ text: 'Out' }])
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
