import type { TeamBrainNode } from './team-brain-structure'

/** The most labels the tree's outer ring holds and stays readable, measured on the home page at 100, 150, 250 and 1000 pages. */
export const TREE_BUDGET = 100

/** An opened folder is drawn over part of the circle, zoomed, so it holds fewer labels than the whole ring. */
export const OPENED_SHARE = 0.5

const oversized = (node: TeamBrainNode, budget: number) => (node.children?.length ?? 0) > budget
const opens = (node: TeamBrainNode, budget: number) => node.kind === 'folder' && (node.children?.length ?? 0) > 0 && !oversized(node, budget)

function slots(list: readonly TeamBrainNode[], levels: number, budget: number): number {
  let n = 0
  for (const node of list) n += levels > 1 && opens(node, budget) ? slots(node.children!, levels - 1, budget) : 1
  return n
}

function depthOf(list: readonly TeamBrainNode[]): number {
  return list.reduce((most, node) => Math.max(most, node.children?.length ? 1 + depthOf(node.children) : 1), 0)
}

/** The newest `keep - 1` of `list`, in its order, and one "+N more" page that lists the rest (or, with `expands`, opens that folder). Its id has an empty segment, so no drive path is it. */
function newestAndMore(list: readonly TeamBrainNode[], keep: number, id: string, expands?: string): TeamBrainNode[] {
  const newest = new Set([...list].sort((a, b) => (a.updatedMinutesAgo ?? Infinity) - (b.updatedMinutesAgo ?? Infinity)).slice(0, keep - 1))
  const rest = list.filter((node) => !newest.has(node))
  const more: TeamBrainNode = { id: `${id}//more`, name: `+${rest.length} more`, kind: 'file', sources: [], more: rest.map((node) => node.name) }
  return [...list.filter((node) => newest.has(node)), expands ? { ...more, expands } : more]
}

/** Past the budget, a folder's newest pages stay and the rest fold into one "+N more" page that lists them. */
const capped = (list: readonly TeamBrainNode[], parentId: string, budget: number) => (list.length <= budget ? list : newestAndMore(list, budget, parentId))

const onlyPages = (node: TeamBrainNode) => !!node.children?.length && node.children.every((child) => child.kind === 'file')

/** The folders where the reveal stops, as `cut` will meet them. */
function boundary(list: readonly TeamBrainNode[], levels: number, expanded: ReadonlySet<string>, budget: number): TeamBrainNode[] {
  return list.flatMap((node) => {
    if (node.kind === 'file' || !node.children?.length || expanded.has(node.id)) return []
    if (levels <= 1 || oversized(node, budget)) return [node]
    return boundary(node.children, levels - 1, expanded, budget)
  })
}

/** A folder of pages at the edge of the reveal: its newest `share` pages, the last slot a "+N more" that opens the folder. */
function preview(node: TeamBrainNode, share: number): TeamBrainNode {
  const pages = node.children!
  return pages.length <= share ? node : { ...node, children: newestAndMore(pages, share, node.id, node.id) }
}

function cut(list: readonly TeamBrainNode[], parentId: string, levels: number, expanded: ReadonlySet<string>, budget: number, share: number): TeamBrainNode[] {
  return capped(list, parentId, budget).map((node) => {
    if (node.kind === 'file' || !node.children?.length) return node
    if (expanded.has(node.id)) return { ...node, children: revealDrive(node.children, expanded, Math.round(budget * OPENED_SHARE), node.id) }
    if ((levels <= 1 || oversized(node, budget)) && share >= 2 && !oversized(node, budget) && onlyPages(node)) return preview(node, share)
    if (levels <= 1 || oversized(node, budget)) return { ...node, children: [], hidden: node.children.length }
    return { ...node, children: cut(node.children, node.id, levels - 1, expanded, budget, share) }
  })
}

/**
 * What the tree draws of a drive: whole levels from the top, as deep as keeps the outer ring within `budget` labels.
 * A folder below that shows as one dot with how many items it holds, or, when it holds only pages, its newest pages
 * and a "+N more". Either opens with the same rule when it is in `expanded`. A folder too big for the budget on its own stays folded and does not hold the others back.
 */
export function revealDrive(drive: readonly TeamBrainNode[], expanded: ReadonlySet<string>, budget = TREE_BUDGET, parentId = ''): TeamBrainNode[] {
  let levels = 1
  const deepest = depthOf(drive)
  while (levels < deepest && slots(drive, levels + 1, budget) <= budget) levels++
  // Where the next level is pages that don't all fit, the ring is filled rather than left bare: each such folder
  // shows an equal share of the room left, newest first.
  const edge = levels < deepest ? boundary(drive, levels, expanded, budget) : []
  const previewed = edge.filter((node) => !oversized(node, budget) && onlyPages(node)).length
  const share = previewed ? Math.floor((budget - (slots(drive, levels, budget) - previewed)) / previewed) : 0
  return cut(drive, parentId, levels, expanded, budget, share)
}
