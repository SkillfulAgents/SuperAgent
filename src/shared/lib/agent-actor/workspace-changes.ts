import { normalizeWorkspacePath } from './workspace-path'

/** Folder names written too often to announce. The container's watcher skips the same. */
const SKIPPED_NAMES = ['node_modules', '.git', '.volume-cache', '.venv', '__pycache__', '.browser-profile', '.bun-cache', '.file-watch-probe']
/** The CLI's own folders under .claude change on every turn. Skills are the agent's files. */
const CLAUDE_DIR = '.claude'
const CLAUDE_KEPT = '.claude/skills'
const WINDOW_MS = 1_000
/** The first change waits this long, so the watcher's echo of an app write joins the same event. */
const FIRST_WAIT_MS = 500
const MAX_SCOPES = 50
/** Past this many queued paths, the queue is collapsed to folders. */
const MAX_QUEUED = 500
const WHOLE = ''

type Broadcast = (event: { type: 'file_changed'; agentSlug: string; scopes: string[] }) => void

const pending = new Map<string, Set<string>>()
const lastSentAt = new Map<string, number>()

function isSkipped(rel: string): boolean {
  if (rel.split('/').some(name => SKIPPED_NAMES.includes(name))) return true
  return rel.startsWith(`${CLAUDE_DIR}/`) && rel !== CLAUDE_KEPT && !rel.startsWith(`${CLAUDE_KEPT}/`)
}

/** Drop every path under another one. Sorting `path/` keys puts a folder right before what is under it. */
function outermost(paths: string[]): string[] {
  const kept: string[] = []
  for (const key of [...new Set(paths)].map(p => `${p}/`).sort()) {
    if (kept.length === 0 || !key.startsWith(kept[kept.length - 1])) kept.push(key)
  }
  return kept.map(key => key.slice(0, -1))
}

/**
 * The fewest scopes covering `paths`, at most `max`: the deepest folder level
 * that still fits. Deeper levels never have fewer scopes, so the level is
 * found by halving, splitting each path once.
 */
export function collapseScopes(paths: Iterable<string>, max = MAX_SCOPES): string[] {
  const all = [...paths]
  if (all.includes(WHOLE)) return [WHOLE]
  const scopes = outermost(all)
  if (scopes.length <= max) return scopes
  const segments = scopes.map(s => s.split('/'))
  const atDepth = (depth: number) => outermost(segments.map(parts => parts.slice(0, depth).join('/')))
  let fits = 0
  let tooMany = Math.max(...segments.map(parts => parts.length))
  while (tooMany - fits > 1) {
    const mid = Math.floor((fits + tooMany) / 2)
    if (atDepth(mid).length <= max) fits = mid
    else tooMany = mid
  }
  return fits === 0 ? [WHOLE] : atDepth(fits)
}

function flush(agentSlug: string, broadcast: Broadcast): void {
  const paths = pending.get(agentSlug)
  pending.delete(agentSlug)
  if (!paths?.size) return
  lastSentAt.set(agentSlug, Date.now())
  broadcast({
    type: 'file_changed',
    agentSlug,
    scopes: collapseScopes(paths).map(s => (s === WHOLE ? '/workspace' : `/workspace/${s}`)),
  })
}

/**
 * Tell the agent's open file views that these workspace paths changed. A path
 * may be a file, a folder, or `''` / `/workspace` for the whole workspace.
 * Sends at most one event per agent per second; the first waits half a second.
 * The caller passes the broadcast, so this module stays free of the server's state.
 */
export function announceWorkspaceChange(agentSlug: string, paths: string[], broadcast: Broadcast): void {
  if (!agentSlug) return
  const rels = paths.flatMap(p => {
    try {
      const rel = normalizeWorkspacePath(p)
      return isSkipped(rel) ? [] : [rel]
    } catch {
      return []
    }
  })
  if (rels.length === 0) return
  const queued = pending.get(agentSlug)
  const next = new Set([...(queued ?? []), ...rels])
  pending.set(agentSlug, next.size > MAX_QUEUED ? new Set(collapseScopes(next)) : next)
  if (queued) return
  const wait = Math.max(FIRST_WAIT_MS, (lastSentAt.get(agentSlug) ?? 0) + WINDOW_MS - Date.now())
  setTimeout(() => flush(agentSlug, broadcast), wait)
}
