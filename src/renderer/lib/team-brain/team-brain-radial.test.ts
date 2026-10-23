import { describe, expect, it } from 'vitest'
import { polar, RADIAL_ROOT, radialTree } from './team-brain-radial'
import { teamBrainDrive } from './team-brain-structure'
import { TEAM_BRAIN_SOURCE_IDS } from './team-brain-schema'

const drive = teamBrainDrive(TEAM_BRAIN_SOURCE_IDS)

describe('radialTree', () => {
  it('puts Team Brain in the middle and everything else a ring out per level', () => {
    const nodes = radialTree(drive)
    const root = nodes.find((n) => n.id === RADIAL_ROOT)!
    expect(root).toMatchObject({ kind: 'root', depth: 0, parent: null })
    const byId = new Map(nodes.map((n) => [n.id, n]))
    for (const node of nodes) {
      if (node.parent === null) continue
      expect(node.depth, node.id).toBe(byId.get(node.parent)!.depth + 1)
    }
    expect(byId.get('customers')).toMatchObject({ depth: 1, section: 'customers' })
    expect(byId.get('customers/acme')).toMatchObject({ depth: 2, section: 'customers', parent: 'customers' })
    expect(byId.get('customers/acme')!.file?.path).toBe('/Customers/Acme Corp.md')
  })

  it('spaces the pages once around the circle, in drive order, and centres each folder on its pages', () => {
    const nodes = radialTree(drive)
    const pages = nodes.filter((n) => n.kind === 'file')
    const angles = pages.map((p) => p.angle)
    expect([...angles].sort((a, b) => a - b)).toEqual(angles)
    expect(angles[0]).toBeGreaterThanOrEqual(0)
    expect(angles[angles.length - 1]).toBeLessThan(2 * Math.PI)
    const customers = nodes.find((n) => n.id === 'customers')!
    const own = pages.filter((p) => p.parent === 'customers').map((p) => p.angle)
    expect(customers.angle).toBeCloseTo((own[0] + own[own.length - 1]) / 2)
  })

  it('follows folders nested more than two deep, each a ring further out, back to the middle', () => {
    const nodes = radialTree(drive)
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const events = byId.get('engineering/services/integrations/slack/events')!
    expect(events).toMatchObject({ depth: 5, kind: 'file', section: 'engineering' })
    expect(events.file?.path).toBe('/Engineering/Services/Integrations/Slack/Events.md')
    const chain: string[] = []
    for (let id: string | null = events.id; id; id = byId.get(id)!.parent) chain.push(id)
    expect(chain).toEqual([
      'engineering/services/integrations/slack/events',
      'engineering/services/integrations/slack',
      'engineering/services/integrations',
      'engineering/services',
      'engineering',
      'team-brain',
    ])
    // Each folder in the chain sits within its pages' span.
    const slack = byId.get('engineering/services/integrations/slack')!
    const pages = nodes.filter((n) => n.parent === slack.id).map((n) => n.angle)
    expect(slack.angle).toBeGreaterThanOrEqual(Math.min(...pages))
    expect(slack.angle).toBeLessThanOrEqual(Math.max(...pages))
  })

  it('holds sections a least angle apart however few pages they hold, keeping each one’s pages together', () => {
    const gap = 0.6
    const before = radialTree(drive)
    const nodes = radialTree(drive, { sectionGap: gap })
    const sections = nodes.filter((n) => n.depth === 1 && n.kind === 'folder').map((n) => n.angle)
    const closest = (angles: number[]) =>
      Math.min(...angles.map((a, i) => (i === angles.length - 1 ? 2 * Math.PI - a + angles[0] : angles[i + 1] - a)))
    // Folder angles sit at the middle of their children, not their pages, so allow a little slack.
    expect(closest(sections)).toBeGreaterThan(gap * 0.9)
    expect(closest(sections)).toBeGreaterThan(closest(before.filter((n) => n.depth === 1 && n.kind === 'folder').map((n) => n.angle)))
    // Still every page once round the circle, in drive order.
    const angles = nodes.filter((n) => n.kind === 'file').map((n) => n.angle)
    expect([...angles].sort((a, b) => a - b)).toEqual(angles)
    expect(angles[angles.length - 1]).toBeLessThan(2 * Math.PI)
  })

  it('measures angles clockwise from twelve o’clock', () => {
    expect(polar(0, 10).y).toBeCloseTo(-10)
    expect(polar(Math.PI / 2, 10).x).toBeCloseTo(10)
  })
})
