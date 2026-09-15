/**
 * Which agents exist and what they are called: the `agents` table, and the
 * slug minting and resolution that go with it. Host level, like the
 * container host — an actor is about one agent, and this is about the set.
 *
 * A local agent's workspace is a directory under the agents data directory.
 * `reconcile` keeps the table in line with those directories, so a database
 * that is lost or reset is rebuilt from the workspaces at the next boot, and
 * a workspace removed by hand disappears from the table. A row placed
 * elsewhere is the only record of its workspace handle and is never removed
 * by reconciliation.
 */
import * as fs from 'fs'
import { desc, eq, inArray } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agents, type AgentRow } from '@shared/lib/db/schema'
import {
  AGENT_ID_LENGTH,
  directoryExists,
  ensureDirectory,
  getAgentClaudeMdPath,
  getAgentDir,
  getAgentsDir,
  listDirectories,
  parseMarkdownWithFrontmatter,
  removeDirectory,
} from '@shared/lib/utils/file-storage'
import { assertPathWithinDir } from '@shared/lib/utils/path-safety'
import type { AgentCatalog, AgentIdentityChanges, AgentRecord, AgentSlug } from './types'

export const LOCAL_RUNTIME = 'local'

// Built on first use rather than at import: suites that stub file-storage
// with a few names load this module through the auth middleware.
let mintedIdPattern: RegExp | undefined
function isMintedSlug(value: string): boolean {
  mintedIdPattern ??= new RegExp(`^[a-z0-9]{${AGENT_ID_LENGTH}}$`)
  return mintedIdPattern.test(value)
}

/**
 * Path-safety gate for any externally-supplied agent identifier. Display
 * slugs only ever contain [a-z0-9-] and minted slugs [a-z0-9], so a
 * legitimate input never contains anything else. Rejecting everything else
 * also forbids '/', '.', and therefore '..' path traversal.
 */
const SAFE_AGENT_INPUT_RE = /^[a-z0-9-]+$/

function randomSlug(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function toRecord(row: AgentRow): AgentRecord {
  return {
    slug: row.slug,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    createdAt: row.createdAt,
    placement: { runtime: row.runtime, workspaceHandle: row.workspaceHandle },
  }
}

/** Coerce a frontmatter scalar to text; the parser turns "123" and "true" into number/boolean. */
function frontmatterString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/**
 * The identity a workspace's `CLAUDE.md` frontmatter carries: what an import
 * brings with it, and what reconciliation seeds a row from. Absent or blank
 * fields are absent here; the caller chooses the fallback.
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

export function createAgentCatalog(): AgentCatalog {
  const rowFor = (slug: AgentSlug): AgentRow | undefined =>
    db.select().from(agents).where(eq(agents.slug, slug)).get()

  // The boot reconcile runs while HTTP is already serving. Until it has
  // finished, the table may be empty (a fresh database, an upgrade) or stale,
  // so every read and write waits for it. Nothing waits when no reconcile
  // has been started: a process that never runs one sees the table as it is.
  let firstReconcile: Promise<unknown> | null = null
  const ready = (): Promise<void> =>
    firstReconcile ? firstReconcile.then(() => undefined, () => undefined) : Promise.resolve()

  const records = async (): Promise<AgentRecord[]> => {
    await ready()
    return db.select().from(agents).orderBy(desc(agents.createdAt), agents.slug).all().map(toRecord)
  }

  const mint = async (): Promise<AgentSlug> => {
    await ready()
    // Checked against the table and against every directory, legacy folders
    // included, so a slug never collides with a workspace the table has not
    // imported yet.
    const maxAttempts = 10
    for (let i = 0; i < maxAttempts; i++) {
      const slug = randomSlug(AGENT_ID_LENGTH)
      if (rowFor(slug) === undefined && !(await directoryExists(getAgentDir(slug)))) {
        return slug
      }
    }
    // Fallback: timestamp + random, still a bare [a-z0-9] string.
    return `${Date.now().toString(36)}${randomSlug(4)}`
  }

  return {
    list: async () => (await records()).map((record) => record.slug),
    records,
    get: async (slug) => {
      await ready()
      const row = rowFor(slug)
      return row === undefined ? null : toRecord(row)
    },
    getMany: async (slugs) => {
      await ready()
      if (slugs.length === 0) return []
      return db
        .select()
        .from(agents)
        .where(inArray(agents.slug, slugs))
        .orderBy(desc(agents.createdAt), agents.slug)
        .all()
        .map(toRecord)
    },
    exists: async (slug) => {
      await ready()
      return rowFor(slug) !== undefined
    },
    mint,
    insert: async ({ slug, name, description, createdAt }) => {
      await ready()
      db.insert(agents).values({
        slug,
        name,
        description: description ?? null,
        createdAt,
        runtime: LOCAL_RUNTIME,
        workspaceHandle: null,
      }).run()
      return toRecord(rowFor(slug)!)
    },
    update: async (slug, changes: AgentIdentityChanges) => {
      await ready()
      const values: Partial<AgentRow> = {}
      if (changes.name !== undefined) values.name = changes.name
      if (changes.description !== undefined) values.description = changes.description
      if (Object.keys(values).length > 0) {
        db.update(agents).set(values).where(eq(agents.slug, slug)).run()
      }
      const row = rowFor(slug)
      return row === undefined ? null : toRecord(row)
    },
    resolve: async (input) => {
      if (!input || !SAFE_AGENT_INPUT_RE.test(input)) return null
      await ready()
      // Exact match handles a bare minted slug and a legacy compound folder name.
      if (rowFor(input) !== undefined) return input
      // Otherwise the slug is the final hyphen-delimited segment (minted slugs
      // have no hyphen); the prefix is decorative and ignored.
      const dash = input.lastIndexOf('-')
      if (dash === -1) return null
      const candidate = input.slice(dash + 1)
      if (isMintedSlug(candidate) && rowFor(candidate) !== undefined) return candidate
      return null
    },
    remove: async (slug) => {
      await ready()
      const row = rowFor(slug)
      if (row === undefined) return
      // The workspace goes first: a removal that fails (a busy mount, a
      // permission) leaves the row, so the agent still exists and the delete
      // can be retried, instead of a workspace on disk that nothing lists.
      if (row.runtime === LOCAL_RUNTIME) {
        const dir = getAgentDir(slug)
        assertPathWithinDir(getAgentsDir(), dir)
        await removeDirectory(dir)
      }
      db.delete(agents).where(eq(agents.slug, slug)).run()
    },
    reconcile: () => {
      const run = reconcileOnce()
      firstReconcile ??= run
      return run
    },
  }

  async function reconcileOnce() {
      const agentsDir = getAgentsDir()
      await ensureDirectory(agentsDir)
      const directories = new Set(await listDirectories(agentsDir))
      const rows = db.select().from(agents).all()
      const known = new Set(rows.map((row) => row.slug))

      const imported: AgentSlug[] = []
      for (const slug of directories) {
        if (known.has(slug)) continue
        // A directory without a readable CLAUDE.md is not an agent, the same
        // as it never was for the listing.
        let content: string
        try {
          content = await fs.promises.readFile(getAgentClaudeMdPath(slug), 'utf-8')
        } catch {
          continue
        }
        const identity = identityFromInstructions(content)
        let createdAt = identity.createdAt
        if (!createdAt) {
          // No usable date in the frontmatter: the directory's own birth time.
          const stat = await fs.promises.stat(getAgentDir(slug)).catch(() => null)
          createdAt = stat && stat.birthtimeMs > 0 ? new Date(stat.birthtimeMs) : new Date()
        }
        db.insert(agents).values({
          slug,
          name: identity.name ?? slug,
          description: identity.description ?? null,
          createdAt,
          runtime: LOCAL_RUNTIME,
          workspaceHandle: null,
        }).run()
        imported.push(slug)
      }

      const removed: AgentSlug[] = []
      for (const row of rows) {
        // A row placed elsewhere is the only record of its workspace: keep it.
        if (row.runtime !== LOCAL_RUNTIME || directories.has(row.slug)) continue
        db.delete(agents).where(eq(agents.slug, row.slug)).run()
        removed.push(row.slug)
      }

      return { imported, removed }
  }
}

export const agentCatalog: AgentCatalog = createAgentCatalog()
