import { describe, expect, it } from 'vitest'
import { countNodes, teamBrainDrive, TEAM_BRAIN_STRUCTURE } from './team-brain-structure'
import { formatMinutesAgo, formatNextSync, formatSince, formatSyncDay, syncTimes } from './team-brain-format'
import { TEAM_BRAIN_SYNCS, syncSummaryParts } from './team-brain-syncs'
import { TEAM_BRAIN_SOURCE_IDS } from './team-brain-schema'

describe('teamBrainDrive', () => {
  it('always proposes Team Brain’s own nodes, and only what connected sources can feed', () => {
    const nothing = teamBrainDrive([])
    expect(nothing.map((n) => n.id)).toEqual(['readme'])

    const slackOnly = teamBrainDrive(['slack'])
    const ids = slackOnly.map((n) => n.id)
    expect(ids).toContain('company')
    expect(ids).toContain('customers')
    expect(ids).not.toContain('engineering')
    const company = slackOnly.find((n) => n.id === 'company')
    expect(company?.children?.map((c) => c.id)).toEqual(['company/team', 'company/glossary'])
  })

  it('reads like a whole team’s wiki once everything is connected', () => {
    const all = teamBrainDrive(TEAM_BRAIN_STRUCTURE.flatMap((n) => n.sources))
    expect(all.map((n) => n.id)).toEqual(['readme', 'company', 'people', 'customers', 'sales', 'marketing', 'brand', 'product', 'engineering', 'meetings'])
    const { folders, files } = countNodes(all)
    expect(folders).toBeGreaterThanOrEqual(20)
    expect(files).toBeGreaterThanOrEqual(70)
    // Every folder says what lives in it, and nothing is empty.
    const walk = (nodes: readonly (typeof all)[number][]): void => {
      for (const node of nodes) {
        if (node.kind !== 'folder') continue
        expect(node.summary, node.id).toBeTruthy()
        expect(node.children?.length, node.id).toBeGreaterThan(0)
        walk(node.children ?? [])
      }
    }
    walk(all)
  })

  it('drops folders the person unticked, children included', () => {
    const all = TEAM_BRAIN_STRUCTURE.flatMap((n) => n.sources)
    const kept = teamBrainDrive(all, ['product'])
    expect(kept.map((n) => n.id)).not.toContain('product')
    const before = countNodes(teamBrainDrive(all))
    const after = countNodes(kept)
    expect(after.folders).toBeLessThan(before.folders)
    expect(after.files).toBeLessThan(before.files)
  })
})

describe('formatting', () => {
  it('reads minutes as people say them', () => {
    expect(formatMinutesAgo(0.4)).toBe('just now')
    expect(formatMinutesAgo(12)).toBe('12 min ago')
    expect(formatMinutesAgo(3 * 60)).toBe('3 h ago')
    expect(formatMinutesAgo(26 * 60)).toBe('yesterday')
    expect(formatMinutesAgo(6 * 24 * 60)).toBe('6 days ago')
  })

  it('handles a missing or bad timestamp', () => {
    expect(formatSince(null)).toBe('never')
    expect(formatSince('garbage')).toBe('never')
    const now = Date.parse('2026-10-21T12:00:00Z')
    expect(formatSince('2026-10-21T11:48:00Z', now)).toBe('12 min ago')
  })

  it('says when the schedule next fires', () => {
    const now = Date.parse('2026-10-21T12:00:00Z')
    expect(formatNextSync('hourly', '2026-10-21T11:47:00Z', now)).toBe('in 47 min')
    expect(formatNextSync('daily', '2026-10-21T01:00:00Z', now)).toBe('in 13 h')
    expect(formatNextSync('weekly', '2026-10-21T01:00:00Z', now)).toBe('in 7 days')
    expect(formatNextSync('hourly', '2026-10-21T09:00:00Z', now)).toBe('any moment')
  })
})

describe('sync summaries', () => {
  it('splits a summary into words, linked pages and the agent that filed one', () => {
    expect(syncSummaryParts('{agent} filed [[Product/Decisions/0009 Pricing change]] today.')).toEqual([
      { agent: true },
      { text: ' filed ' },
      { page: 'Product/Decisions/0009 Pricing change' },
      { text: ' today.' },
    ])
    expect(syncSummaryParts('No links here.')).toEqual([{ text: 'No links here.' }])
  })

  it('links only pages the drive has', () => {
    const paths = new Set<string>()
    const walk = (list: ReturnType<typeof teamBrainDrive>, at: string) =>
      list.forEach((n) => (n.kind === 'file' ? paths.add(`${at}${n.name}`.replace(/\.md$/, '')) : walk(n.children ?? [], `${at}${n.name}/`)))
    walk(teamBrainDrive(TEAM_BRAIN_SOURCE_IDS), '')
    for (const sync of TEAM_BRAIN_SYNCS) {
      for (const text of [...sync.highlights.map((h) => h.body), ...sync.changes]) {
        for (const part of syncSummaryParts(text)) if ('page' in part) expect(paths, part.page).toContain(part.page)
      }
    }
  })

  it('times each sync one schedule period before the next, from the last', () => {
    const last = '2026-10-22T09:00:00.000Z'
    expect(syncTimes('daily', last, 3).map((d) => d.toISOString())).toEqual([last, '2026-10-21T09:00:00.000Z', '2026-10-20T09:00:00.000Z'])
    expect(syncTimes('hourly', last, 2)[1].toISOString()).toBe('2026-10-22T08:00:00.000Z')
  })

  it('names the day a sync ran as people do', () => {
    const now = new Date(2026, 9, 22, 15)
    expect(formatSyncDay(new Date(2026, 9, 22, 9), now)).toBe('Today')
    expect(formatSyncDay(new Date(2026, 9, 21, 23), now)).toBe('Yesterday')
    expect(formatSyncDay(new Date(2026, 9, 19, 9), now)).toMatch(/19/)
  })
})
