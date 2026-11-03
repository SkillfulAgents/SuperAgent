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
import { agentAvatarSchema } from '@shared/lib/types/agent-avatar'
import { randomAgentAvatar } from './agent-avatar'
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
    avatar: agentAvatarSchema.parse({ color: row.avatarColor, shape: row.avatarShape }),
    ...(row.description === null ? {} : { description: row.description }),
    createdAt: row.createdAt,
    placement: { runtime: row.runtime, workspaceHandle: row.workspaceHandle },
  }
}

/**
 * Callers that ask for one key while its read runs get that read instead of starting another.
 * Nothing is kept once it settles, so no caller gets a result older than a read in progress.
 */
function sharedReads<T>() {
  const running = new Map<string, Promise<T>>()
  return {
    run(key: string, read: () => Promise<T>): Promise<T> {
      const current = running.get(key)
      if (current) return current
      const started = read()
      running.set(key, started)
      const done = () => {
        if (running.get(key) === started) running.delete(key)
      }
      started.then(done, done)
      return started
    },
    /** After a write, later callers start a new read instead of joining one that began before it. */
    clear: () => running.clear(),
  }
}

export function createAgentCatalog(): AgentCatalog {
  // Requests for one agent arrive together (a page load), and where the database is a network
  // round trip each lookup costs one: concurrent lookups of one agent share a query.
  const rowReads = sharedReads<AgentRow | undefined>()
  const resolveReads = sharedReads<AgentRow | undefined>()
  const forgetReads = () => {
    rowReads.clear()
    resolveReads.clear()
  }

  const rowFor = (slug: AgentSlug): Promise<AgentRow | undefined> =>
    rowReads.run(slug, async () => db.select().from(agents).where(eq(agents.slug, slug)).get())

  // An exact match is a bare minted slug or a legacy compound folder name. Otherwise the slug is the
  // final hyphen-delimited segment (minted slugs have no hyphen); the prefix is decorative. A display
  // slug looks up both forms in one query, and the exact match wins.
  const resolveRow = async (input: string): Promise<AgentRow | undefined> => {
    if (!input || !SAFE_AGENT_INPUT_RE.test(input)) return undefined
    const candidate = input.slice(input.lastIndexOf('-') + 1)
    if (candidate === input || !isMintedSlug(candidate)) return rowFor(input)
    return resolveReads.run(input, async () => {
      const rows = await db.select().from(agents).where(inArray(agents.slug, [input, candidate])).all()
      return rows.find((row) => row.slug === input) ?? rows.find((row) => row.slug === candidate)
    })
  }

  const records = async (): Promise<AgentRecord[]> =>
    (await db.select().from(agents).orderBy(desc(agents.createdAt), agents.slug).all()).map(toRecord)

  const mint = async (): Promise<AgentSlug> => {
    // Checked against the table and against every directory, legacy folders
    // included, so a slug never collides with a workspace the table does not
    // know.
    const maxAttempts = 10
    for (let i = 0; i < maxAttempts; i++) {
      const slug = randomSlug(AGENT_ID_LENGTH)
      if ((await rowFor(slug)) === undefined && !(await directoryExists(getAgentDir(slug)))) {
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
      const row = await rowFor(slug)
      return row === undefined ? null : toRecord(row)
    },
    getMany: async (slugs) => {
      if (slugs.length === 0) return []
      const rows = await db
        .select()
        .from(agents)
        .where(inArray(agents.slug, slugs))
        .orderBy(desc(agents.createdAt), agents.slug)
        .all()
      return rows.map(toRecord)
    },
    exists: async (slug) => (await rowFor(slug)) !== undefined,
    mint,
    insert: async ({ slug, name, description, createdAt }) => {
      const avatar = randomAgentAvatar()
      await db.insert(agents).values({
        slug,
        name,
        avatarColor: avatar.color,
        avatarShape: avatar.shape,
        description: description ?? null,
        createdAt,
        runtime: LOCAL_RUNTIME,
        workspaceHandle: null,
      }).run()
      forgetReads()
      return toRecord((await rowFor(slug))!)
    },
    update: async (slug, changes: AgentIdentityChanges) => {
      const values: Partial<AgentRow> = {}
      if (changes.name !== undefined) values.name = changes.name
      if (changes.description !== undefined) values.description = changes.description
      if (changes.avatar !== undefined) {
        const avatar = agentAvatarSchema.parse(changes.avatar)
        values.avatarColor = avatar.color
        values.avatarShape = avatar.shape
      }
      if (Object.keys(values).length > 0) {
        await db.update(agents).set(values).where(eq(agents.slug, slug)).run()
        forgetReads()
      }
      const row = await rowFor(slug)
      return row === undefined ? null : toRecord(row)
    },
    resolve: async (input) => (await resolveRow(input))?.slug ?? null,
    resolveRecord: async (input) => {
      const row = await resolveRow(input)
      return row === undefined ? null : toRecord(row)
    },
    remove: async (slug) => {
      const row = await rowFor(slug)
      if (row === undefined) return
      // The workspace goes first: a removal that fails (a busy mount, a
      // permission) leaves the row, so the agent still exists and the delete
      // can be retried, instead of a workspace on disk that nothing lists.
      if (row.runtime === LOCAL_RUNTIME) {
        const dir = getAgentDir(slug)
        assertPathWithinDir(getAgentsDir(), dir)
        await removeDirectory(dir)
      }
      await db.delete(agents).where(eq(agents.slug, slug)).run()
      forgetReads()
    },
  }
}

export const agentCatalog: AgentCatalog = createAgentCatalog()
