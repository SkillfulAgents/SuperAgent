/**
 * What an agent directory says about the agent it holds: the identity in the
 * frontmatter of its instructions document. Synchronous and free of the database, so
 * the data migration that imports directories into the catalog table can run
 * it while the database is being opened.
 */
import * as fs from 'fs'
import * as path from 'path'
import { getAgentClaudeMdPath, getAgentDir, getAgentsDir, getAgentWorkspaceDir, parseMarkdownWithFrontmatter } from '@shared/lib/utils/file-storage'
import type { AgentSlug } from './types'

/** The runtime of an agent whose workspace is a directory under the agents data directory. */
export const LOCAL_RUNTIME = 'local'

export interface AgentDirectoryIdentity {
  slug: AgentSlug
  name: string
  description?: string
  createdAt: Date
}

/** Coerce a frontmatter scalar to text; the parser turns "123" and "true" into number/boolean. */
function frontmatterString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/**
 * The identity a workspace's instructions frontmatter carries: what an import
 * brings with it, and what the directory import seeds a row from. Absent or
 * blank fields are absent here; the caller chooses the fallback.
 */
export function identityFromInstructions(
  content: string,
): { name?: string; description?: string; createdAt?: Date } {
  const { frontmatter } = parseMarkdownWithFrontmatter<Record<string, unknown>>(content)
  const name = frontmatterString(frontmatter.name)
  const description = frontmatterString(frontmatter.description)
  const createdAtRaw = frontmatterString(frontmatter.createdAt)
  const createdAt = createdAtRaw ? new Date(createdAtRaw) : undefined
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(createdAt === undefined || Number.isNaN(createdAt.getTime()) ? {} : { createdAt }),
  }
}

/**
 * Every directory under the agents data directory that holds a readable
 * instructions document, with legacy `CLAUDE.md` taking precedence over
 * `AGENTS.md`, as in the runtime. The name falls back to
 * the slug and the creation date to the directory's birth time.
 */
export function readAgentDirectoriesSync(): AgentDirectoryIdentity[] {
  const agentsDir = getAgentsDir()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const found: AgentDirectoryIdentity[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const slug = entry.name
    let content: string
    try {
      try {
        content = fs.readFileSync(getAgentClaudeMdPath(slug), 'utf-8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        content = fs.readFileSync(path.join(getAgentWorkspaceDir(slug), 'AGENTS.md'), 'utf-8')
      }
    } catch {
      continue
    }
    const identity = identityFromInstructions(content)
    let createdAt = identity.createdAt
    if (!createdAt) {
      let birth = 0
      try {
        birth = fs.statSync(getAgentDir(slug)).birthtimeMs
      } catch {
        // fall through to now
      }
      createdAt = birth > 0 ? new Date(birth) : new Date()
    }
    found.push({
      slug,
      name: identity.name ?? slug,
      ...(identity.description === undefined ? {} : { description: identity.description }),
      createdAt,
    })
  }
  return found
}

/**
 * Rename a local agent's `CLAUDE.md` to `AGENTS.md`. Returns whether it did: an
 * agent with no `CLAUDE.md`, or one that already has an `AGENTS.md`, is left
 * as it is, since the CLI reads `CLAUDE.md` first and moving it over the other
 * would change the instructions the agent runs with.
 */
export function renameClaudeMdToAgentsMdSync(slug: AgentSlug): boolean {
  const claudeMd = getAgentClaudeMdPath(slug)
  const agentsMd = path.join(getAgentWorkspaceDir(slug), 'AGENTS.md')
  if (!fs.lstatSync(claudeMd, { throwIfNoEntry: false })?.isFile()) return false
  if (fs.lstatSync(agentsMd, { throwIfNoEntry: false })) return false
  fs.renameSync(claudeMd, agentsMd)
  return true
}
