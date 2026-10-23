import type { TeamBrainNode } from './team-brain-structure'

/**
 * The drive as a radial tree: Team Brain at the middle, a ring for each level
 * of folders, and every page on the outer ring, as a dendrogram. Pages are
 * spaced evenly around the circle in drive order, with a wider gap between
 * groups (as d3's cluster layout separates cousins from siblings); a folder
 * sits at the middle of its pages' span. Angles run clockwise from twelve
 * o'clock, in radians. Sections can be held a least angle apart, however few
 * pages they hold (`sectionGap`), by widening the gaps between them.
 */

export interface RadialNode {
  id: string
  label: string
  kind: 'root' | 'folder' | 'file'
  /** The top-level section it belongs to; the root has none. */
  section: string | null
  depth: number
  angle: number
  parent: string | null
  /** For a file: the page, where it sits in the drive, and its folder. */
  file?: { node: TeamBrainNode; path: string; folder?: TeamBrainNode }
}

export const RADIAL_ROOT = 'team-brain'

/** Turn a ring position into a point, with the middle at the origin. */
export function polar(angle: number, radius: number) {
  return { x: radius * Math.sin(angle), y: -radius * Math.cos(angle) }
}

export function radialTree(drive: readonly TeamBrainNode[], { sectionGap = 0 }: { sectionGap?: number } = {}): RadialNode[] {
  const out: RadialNode[] = [
    { id: RADIAL_ROOT, label: 'Team Brain', kind: 'root', section: null, depth: 0, angle: 0, parent: null },
  ]
  const leaves: RadialNode[] = []
  const children = new Map<string, RadialNode[]>()

  const walk = (list: readonly TeamBrainNode[], parent: RadialNode, section: string | null, folder: TeamBrainNode | undefined, path: string) => {
    for (const node of list) {
      const at = `${path}/${node.name}`
      const radial: RadialNode = {
        id: node.id,
        label: node.name.replace(/\.md$/, ''),
        kind: node.kind,
        section: section ?? node.id,
        depth: parent.depth + 1,
        angle: 0,
        parent: parent.id,
        file: node.kind === 'file' ? { node, path: at, folder } : undefined,
      }
      out.push(radial)
      children.set(parent.id, [...(children.get(parent.id) ?? []), radial])
      const kids = node.children ?? []
      if (node.kind === 'file' || kids.length === 0) leaves.push(radial)
      else walk(kids, radial, section ?? node.id, node, at)
    }
  }
  walk(drive, out[0], null, undefined, '')

  // Siblings sit one step apart; the first page of a new folder, a step and a half.
  const steps: number[] = leaves.map((leaf, i) => (i === 0 ? 0 : leaf.parent === leaves[i - 1].parent ? 1 : 1.5))
  let tail = 1.5
  spreadSections(drive, leaves, steps, sectionGap, (extra) => (tail += extra))
  const total = steps.reduce((sum, s) => sum + s, 0) + tail
  let offset = 0
  leaves.forEach((leaf, i) => {
    offset += steps[i]
    leaf.angle = (offset / total) * 2 * Math.PI
  })

  // A folder sits at the middle of its children's span, deepest folders first.
  for (const node of [...out].sort((a, b) => b.depth - a.depth)) {
    const kids = children.get(node.id)
    if (!kids || node.kind === 'root') continue
    node.angle = (kids[0].angle + kids[kids.length - 1].angle) / 2
  }
  return out
}

/**
 * Widen the gaps between top-level folders until each sits at least `gap`
 * round from the next (and the last from the first), by adding to `steps`
 * before a section's first page, or to the gap after the last page through
 * `addToTail`. A section's own pages keep their spacing. Pages straight off
 * the middle, like the README, are no section and need no room of their own.
 */
function spreadSections(
  drive: readonly TeamBrainNode[],
  leaves: readonly RadialNode[],
  steps: number[],
  gap: number,
  addToTail: (extra: number) => void,
) {
  const folders = new Set(drive.filter((n) => n.kind === 'folder').map((n) => n.id))
  const spans: { first: number; last: number }[] = []
  let current: string | null = null
  leaves.forEach((leaf, i) => {
    if (!leaf.section || !folders.has(leaf.section)) return void (current = null)
    if (leaf.section === current) spans[spans.length - 1].last = i
    else spans.push({ first: i, last: i })
    current = leaf.section
  })
  if (gap <= 0 || spans.length < 2) return
  const full = 2 * Math.PI
  // Folders sit at least `gap` apart only if they can all fit round the circle.
  const least = Math.min(gap, (0.9 * full) / spans.length)
  let tail = 1.5
  // Each widening grows the circle, and with it what `least` is in steps, so settle it over a few rounds.
  for (let round = 0; round < 60; round++) {
    const at: number[] = []
    steps.forEach((step, i) => at.push((at[i - 1] ?? 0) + step))
    const total = at[at.length - 1] + tail
    const need = (least / full) * total
    const centre = (span: { first: number; last: number }) => (at[span.first] + at[span.last]) / 2
    let short = 0
    spans.forEach((span, j) => {
      const next = spans[(j + 1) % spans.length]
      const wraps = j === spans.length - 1
      const apart = wraps ? total - centre(span) + centre(next) : centre(next) - centre(span)
      const deficit = need - apart
      if (deficit <= 0) return
      short = Math.max(short, deficit)
      if (wraps) {
        tail += deficit
        addToTail(deficit)
      } else steps[next.first] += deficit
    })
    if (short < 1e-3) break
  }
}
