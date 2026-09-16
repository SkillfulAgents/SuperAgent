/**
 * Which agents exist and what they are called: the `agents` table, and the
 * slug minting and resolution that go with it. Host level, like the
 * container host — an actor is about one agent, and this is about the set.
 *
 * A local agent's workspace is a directory under the agents data directory.
 * The table is filled from those directories once, by the data migration
 * that runs when the database is opened (`db/data-migrations`), and from then
 * on the table is the authority: a directory placed or removed by hand while
 * the app runs is not picked up. A row placed elsewhere is the only record of
 * its workspace handle.
 */
import { desc, eq, inArray } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agents, type AgentRow } from '@shared/lib/db/schema'
import {
  AGENT_ID_LENGTH,
  directoryExists,
  getAgentDir,
  getAgentsDir,
  removeDirectory,
} from '@shared/lib/utils/file-storage'
import { assertPathWithinDir } from '@shared/lib/utils/path-safety'
import { LOCAL_RUNTIME } from './agent-directories'
import type { AgentCatalog, AgentIdentityChanges, AgentRecord, AgentSlug } from './types'

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

export function createAgentCatalog(): AgentCatalog {
  const rowFor = (slug: AgentSlug): AgentRow | undefined =>
    db.select().from(agents).where(eq(agents.slug, slug)).get()

  const records = async (): Promise<AgentRecord[]> =>
    db.select().from(agents).orderBy(desc(agents.createdAt), agents.slug).all().map(toRecord)

  const mint = async (): Promise<AgentSlug> => {
    // Checked against the table and against every directory, legacy folders
    // included, so a slug never collides with a workspace the table does not
    // know.
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
      const row = rowFor(slug)
      return row === undefined ? null : toRecord(row)
    },
    getMany: async (slugs) => {
      if (slugs.length === 0) return []
      return db
        .select()
        .from(agents)
        .where(inArray(agents.slug, slugs))
        .orderBy(desc(agents.createdAt), agents.slug)
        .all()
        .map(toRecord)
    },
    exists: async (slug) => rowFor(slug) !== undefined,
    mint,
    insert: async ({ slug, name, description, createdAt }) => {
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
  }
}

export const agentCatalog: AgentCatalog = createAgentCatalog()
