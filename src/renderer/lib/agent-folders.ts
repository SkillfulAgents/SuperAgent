import type { ApiAgent } from '@renderer/hooks/use-agents'

/**
 * Left-nav agent folders.
 *
 * Folders are a *user projection* over the shared agent list, exactly like
 * `agentOrder` in `agent-ordering.ts`: they live in that user's row of
 * `user_settings`, so filing a shared agent never moves it for anybody else.
 *
 * The left nav's top level is a list of folders and nothing else. "Your
 * Agents" is one of them — the always-present default folder that holds every
 * agent not filed anywhere. It can be reordered and collapsed like the rest,
 * but never renamed or deleted, because it is where everything falls back to:
 * an agent whose folder was deleted, an agent another user shared, a brand-new
 * agent. Folders do not nest.
 *
 * Everything here is pure and dnd-kit-free — the sidebar owns the drag
 * plumbing, this file owns the shape of the sections and every mutation on
 * them.
 *
 * Two properties the rest of the feature leans on:
 *
 * 1. **Dangling references resolve to "Your Agents".** An assignment naming a
 *    deleted folder, an order entry naming something gone, an agent with no
 *    assignment at all — each lands in the default folder rather than being
 *    repaired. That is why deleting an agent or a folder needs no cascade, and
 *    why there is no migration: settings written before this model (which
 *    stored agent slugs in the top-level order) parse fine, the slug entries
 *    are simply ignored.
 * 2. **The rendered sections are the source of truth for order.** Flattening
 *    them in reading order yields the one flat `agentOrder` that the home
 *    grid, the graph and the tray consume without knowing folders exist.
 */

export interface AgentFolder {
  id: string
  name: string
}

/** One top-level block: a folder (the default one included) and its agents. */
export interface FolderSection {
  folder: AgentFolder
  isRoot: boolean
  agents: ApiAgent[]
}

/**
 * The default folder's id. User folders get uuids, so this can never collide;
 * a stored folder claiming this id is discarded defensively.
 */
export const ROOT_FOLDER_ID = 'root'
export const ROOT_FOLDER_NAME = 'Your Agents'

export const DEFAULT_FOLDER_NAME = 'New Folder'

/**
 * Ids for a folder's two drag roles. The `::` separator cannot occur in an
 * agent slug (they are filesystem directory names), so neither can ever
 * collide with an agent id inside the same DndContext.
 */
export function containerIdForFolder(folderId: string): string {
  return `agent-section::${folderId}`
}

export function sortableIdForFolder(folderId: string): string {
  return `agent-folder::${folderId}`
}

export function newFolderId(): string {
  return crypto.randomUUID()
}

/**
 * Drop stored folder entries that can only come from a hand-edited or buggy
 * write: one claiming the default folder's id, and any repeat of an id already
 * seen (first occurrence wins). Two entries sharing an id would render two
 * sections aliasing one member list, and every move involving them would
 * silently revert on the next write — a state no gesture can repair.
 */
export function sanitizeFolders(folders: AgentFolder[] | undefined): AgentFolder[] {
  const seen = new Set<string>([ROOT_FOLDER_ID])
  return (folders ?? []).filter((folder) => {
    if (seen.has(folder.id)) return false
    seen.add(folder.id)
    return true
  })
}

// ─── Read ────────────────────────────────────────────────────────────────────

/**
 * Assemble the sections from an already-ordered agent list plus the stored
 * fields. Within a section, agents keep their relative order from
 * `orderedAgents` (i.e. from `applyAgentOrder`).
 *
 * Placement fallbacks double as the upgrade path: a folder with no place in
 * the stored order was just created and renders last; the default folder with
 * no place renders first, which — together with unassigned agents landing in
 * it — reproduces the pre-folders layout exactly on an untouched install.
 */
export function buildFolderSections(
  orderedAgents: ApiAgent[],
  folders: AgentFolder[] | undefined,
  assignments: Record<string, string> | undefined,
  listOrder: string[] | undefined
): FolderSection[] {
  const userFolders = sanitizeFolders(folders)
  const members = new Map<string, ApiAgent[]>(userFolders.map((f) => [f.id, []]))
  const rootAgents: ApiAgent[] = []

  for (const agent of orderedAgents) {
    const folderId = assignments?.[agent.slug]
    const bucket = folderId ? members.get(folderId) : undefined
    if (bucket) bucket.push(agent)
    else rootAgents.push(agent)
  }

  const sections: FolderSection[] = [
    {
      folder: { id: ROOT_FOLDER_ID, name: ROOT_FOLDER_NAME },
      isRoot: true,
      agents: rootAgents,
    },
    ...userFolders.map((folder) => ({
      folder,
      isRoot: false,
      agents: members.get(folder.id)!,
    })),
  ]

  const rank = new Map((listOrder ?? []).map((key, index) => [key, index]))
  const placeOf = (section: FolderSection) => {
    const stored = rank.get(sortableIdForFolder(section.folder.id))
    if (stored !== undefined) return stored
    return section.isRoot ? -1 : rank.size + 1
  }

  return sections
    .map((section, index) => ({ section, index, place: placeOf(section) }))
    .sort((a, b) => a.place - b.place || a.index - b.index)
    .map((entry) => entry.section)
}

/** Collapse the rendered sections back into the stored fields. */
export function sectionsToSettings(sections: FolderSection[]): {
  agentOrder: string[]
  agentListOrder: string[]
  agentFolders: AgentFolder[]
  agentFolderAssignments: Record<string, string>
} {
  const agentOrder: string[] = []
  const agentListOrder: string[] = []
  const agentFolders: AgentFolder[] = []
  const agentFolderAssignments: Record<string, string> = {}

  for (const section of sections) {
    agentListOrder.push(sortableIdForFolder(section.folder.id))
    if (!section.isRoot) agentFolders.push(section.folder)
    for (const agent of section.agents) {
      agentOrder.push(agent.slug)
      // Default-folder members get NO assignment entry — "unfiled" stays the
      // fallback state, which is what keeps dangling references self-healing.
      if (!section.isRoot) agentFolderAssignments[agent.slug] = section.folder.id
    }
  }

  return { agentOrder, agentListOrder, agentFolders, agentFolderAssignments }
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

export interface AgentLocation {
  sectionIndex: number
  memberIndex: number
}

export function locateAgent(sections: FolderSection[], slug: string): AgentLocation | null {
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const memberIndex = sections[sectionIndex].agents.findIndex((a) => a.slug === slug)
    if (memberIndex !== -1) return { sectionIndex, memberIndex }
  }
  return null
}

function sectionIndexForContainer(sections: FolderSection[], overId: string): number {
  return sections.findIndex(
    (s) =>
      overId === sortableIdForFolder(s.folder.id) || overId === containerIdForFolder(s.folder.id)
  )
}

/** Where a dragged agent would land, given whatever the pointer is over. */
export interface AgentDropTarget {
  folderId: string
  index: number
}

export function resolveAgentDrop(
  sections: FolderSection[],
  overId: string
): AgentDropTarget | null {
  // The header and the body both mean "into this folder, at the end" — the
  // header is the only way into a collapsed folder, which renders no body.
  const bySection = sectionIndexForContainer(sections, overId)
  if (bySection !== -1) {
    const section = sections[bySection]
    return { folderId: section.folder.id, index: section.agents.length }
  }

  const location = locateAgent(sections, overId)
  if (!location) return null
  return {
    folderId: sections[location.sectionIndex].folder.id,
    index: location.memberIndex,
  }
}

/** The top-level slot a dragged folder would land in. */
export function resolveFolderDrop(sections: FolderSection[], overId: string): number | null {
  const bySection = sectionIndexForContainer(sections, overId)
  if (bySection !== -1) return bySection

  // Over an agent row: the slot of the section holding it.
  const location = locateAgent(sections, overId)
  return location ? location.sectionIndex : null
}

// ─── Mutations on the sections ───────────────────────────────────────────────

/** Same semantics as dnd-kit's arrayMove: the item ends up AT `to`. */
function move<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(value, max))
}

export function moveAgent(
  sections: FolderSection[],
  slug: string,
  target: AgentDropTarget
): FolderSection[] {
  const from = locateAgent(sections, slug)
  if (!from) return sections
  const source = sections[from.sectionIndex]

  if (source.folder.id === target.folderId) {
    const to = clamp(target.index, source.agents.length - 1)
    if (to === from.memberIndex) return sections
    const next = sections.slice()
    next[from.sectionIndex] = { ...source, agents: move(source.agents, from.memberIndex, to) }
    return next
  }

  const targetIndex = sections.findIndex((s) => s.folder.id === target.folderId)
  if (targetIndex === -1) return sections

  const agent = source.agents[from.memberIndex]
  const next = sections.slice()
  next[from.sectionIndex] = {
    ...source,
    agents: source.agents.filter((a) => a.slug !== slug),
  }
  const destination = next[targetIndex]
  const agents = destination.agents.slice()
  const insertAt = target.index < 0 || target.index > agents.length ? agents.length : target.index
  agents.splice(insertAt, 0, agent)
  next[targetIndex] = { ...destination, agents }
  return next
}

/** Move a folder (the default one included) to a top-level slot. */
export function moveFolder(
  sections: FolderSection[],
  folderId: string,
  toIndex: number
): FolderSection[] {
  const from = sections.findIndex((s) => s.folder.id === folderId)
  if (from === -1) return sections
  const to = clamp(toIndex, sections.length - 1)
  return to === from ? sections : move(sections, from, to)
}

/**
 * Delete a folder, appending its members to the default folder. They would
 * land there anyway once their assignments dangle; doing it explicitly keeps
 * their relative order and lets the caller write the result in one update.
 * The default folder itself cannot be dissolved.
 */
export function dissolveFolder(sections: FolderSection[], folderId: string): FolderSection[] {
  if (folderId === ROOT_FOLDER_ID) return sections
  const index = sections.findIndex((s) => s.folder.id === folderId)
  if (index === -1) return sections
  const dissolved = sections[index]

  return sections
    .filter((_, i) => i !== index)
    .map((section) =>
      section.isRoot ? { ...section, agents: [...section.agents, ...dissolved.agents] } : section
    )
}

// ─── Mutations on the stored fields ──────────────────────────────────────────

/**
 * Assign an agent to a folder. `null` or the default folder both mean
 * "unfiled": the key is deleted rather than written, preserving absence as
 * the fallback state.
 */
export function assignAgentToFolder(
  assignments: Record<string, string> | undefined,
  slug: string,
  folderId: string | null
): Record<string, string> {
  const next = { ...(assignments ?? {}) }
  if (folderId === null || folderId === ROOT_FOLDER_ID) delete next[slug]
  else next[slug] = folderId
  return next
}

/** A name that does not collide with an existing folder ("New Folder 2", …). */
export function uniqueFolderName(folders: AgentFolder[], base = DEFAULT_FOLDER_NAME): string {
  const taken = new Set(folders.map((f) => f.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate)) return candidate
  }
}
