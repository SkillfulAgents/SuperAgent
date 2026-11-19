/**
 * Skillset reconciliation — provider-polymorphic cleanup of stale skillset
 * configs and installed skill/agent-template metadata.
 *
 * Replaces the old `reconcilePlatformSkillsets` that hard-coded
 * `provider === 'platform'` checks. Each provider decides via
 * `isConfigValid` / `isInstalledValid` whether a record is still valid for
 * the current auth state. github's default returns true; platform checks
 * orgId against the connected platform auth.
 *
 * Installed skills and template metadata live in an agent's workspace, so
 * they are read and removed through the agent actor's `files`; the paths
 * here are workspace paths.
 *
 * Typical callers:
 *  - `savePlatformAuth` on org switch / disconnect — eager full sweep
 *  - metadata readers on access — lazy backstop
 */

import { getSettings, mutateSettings } from '@shared/lib/config/settings'
import { getSkillsetProvider } from '@shared/lib/skillset-provider'
import {
  skillsetAuthContextFrom,
  type SkillsetAuthContext,
} from '@shared/lib/skillset-provider/base-skillset-provider'
import {
  agentCatalog,
  agentRegistry,
  joinWorkspacePath,
  WorkspaceFileError,
  type FileEntry,
  type FileOps,
} from '@shared/lib/agent-actor'
import { captureException } from '@shared/lib/error-reporting'
import type {
  InstalledAgentMetadata,
  InstalledSkillMetadata,
  SkillsetConfig,
} from '@shared/lib/types/skillset'

/** Where an agent's installed skills live, relative to its workspace root. */
const SKILLS_WORKSPACE_DIR = '.claude/skills'
const SKILL_METADATA_FILE = '.skillset-metadata.json'
/** The agent-template metadata file, at the workspace root. */
const TEMPLATE_METADATA_PATH = '.skillset-agent-metadata.json'

/**
 * Filter out SkillsetConfig entries that are no longer valid for the current
 * auth state. Mutates settings.skillsets and persists if anything changed.
 */
export async function reconcileSkillsetConfigsForCurrentAuth(): Promise<{ removed: number }> {
  // Filter against a FRESH read inside the compare-and-set so a concurrent
  // add/remove of an unrelated skillset isn't lost, and judge each config by
  // the auth state in that same read. The mutator may run more than once, so
  // it only assigns `removed` and `failures`, and failures are reported after.
  let removed = 0
  let failures: unknown[] = []
  await mutateSettings((settings) => {
    failures = []
    // Once per attempt, from this attempt's own settings.
    const auth = skillsetAuthContextFrom(settings)
    const before = settings.skillsets ?? []
    const kept = before.filter((c) => {
      try {
        return getSkillsetProvider(c.provider).isConfigValid(c, auth)
      } catch (error) {
        failures.push(error)
        // Fail-open: if the provider check throws, keep the config so we don't
        // mass-delete on a transient error.
        return true
      }
    })
    removed = before.length - kept.length
    if (removed === 0) return false
    settings.skillsets = kept
  })
  for (const error of failures) {
    captureException(error, { tags: { area: 'skillset-reconcile', op: 'isConfigValid' } })
  }
  return { removed }
}

function providerCheckInstalled(meta: unknown, auth: SkillsetAuthContext): boolean {
  if (!meta || typeof meta !== 'object') return true
  const m = meta as Partial<Pick<InstalledSkillMetadata | InstalledAgentMetadata,
    'provider' | 'providerData'>>
  try {
    return getSkillsetProvider(m.provider).isInstalledValid(m, auth)
  } catch (error) {
    captureException(error, { tags: { area: 'skillset-reconcile', op: 'isInstalledValid' } })
    return true
  }
}

/**
 * Whether an installed record is still valid, judged against settings read
 * now: deleting a workspace file rests on this, so it is never decided from a
 * read taken before a long sweep. Fail-open (keep) when the settings cannot
 * be read, like a provider check that throws.
 */
async function installedStillValid(meta: unknown): Promise<boolean> {
  const auth = await readSkillsetAuthScreen()
  return auth ? providerCheckInstalled(meta, auth) : true
}

/**
 * The auth state now, for screening many installed records with one settings
 * read (a listing, a sweep); undefined when the settings cannot be read, which
 * leaves each record to its own check. A screen only clears records: deleting
 * one still rests on a fresh read (see the prune helpers).
 */
export async function readSkillsetAuthScreen(): Promise<SkillsetAuthContext | undefined> {
  try {
    return skillsetAuthContextFrom(await getSettings())
  } catch (error) {
    captureException(error, { tags: { area: 'skillset-reconcile', op: 'read-settings' } })
    return undefined
  }
}

/** Whether `screen` already clears the record, so no read is needed to keep it. */
function clearedBy(meta: unknown, screen: SkillsetAuthContext | undefined): boolean {
  return screen !== undefined && providerCheckInstalled(meta, screen)
}

/**
 * Lazy-cleanup helper for skill metadata readers. Given a parsed metadata
 * object and the skill directory's workspace path, delete the directory if
 * the provider says the record is no longer valid. Returns true if a cleanup
 * happened. `screen`: the caller's {@link readSkillsetAuthScreen} when it
 * checks many records; a record it clears is kept without another read, and
 * any other is checked against settings read now before it is deleted.
 */
export async function pruneInstalledSkillIfInvalid(
  meta: unknown,
  files: FileOps,
  skillDir: string,
  screen?: SkillsetAuthContext,
): Promise<boolean> {
  if (clearedBy(meta, screen)) return false
  if (await installedStillValid(meta)) return false
  try {
    await files.delete(skillDir, { recursive: true })
  } catch (error) {
    captureException(error, { tags: { area: 'skillset-reconcile', op: 'rm-skill' } })
  }
  return true
}

/**
 * Lazy-cleanup helper for agent-template metadata readers: `metaPath` is the
 * metadata file's workspace path; `screen` as for {@link pruneInstalledSkillIfInvalid}.
 */
export async function pruneInstalledTemplateIfInvalid(
  meta: unknown,
  files: FileOps,
  metaPath: string,
  screen?: SkillsetAuthContext,
): Promise<boolean> {
  if (clearedBy(meta, screen)) return false
  if (await installedStillValid(meta)) return false
  try {
    await files.delete(metaPath)
  } catch (error) {
    captureException(error, { tags: { area: 'skillset-reconcile', op: 'unlink-template' } })
  }
  return true
}

/** A workspace file parsed as JSON, or null when it is absent, not a file, or not JSON. */
async function readWorkspaceJson(files: FileOps, workspacePath: string): Promise<unknown | null> {
  let bytes: Uint8Array | null
  try {
    bytes = await files.getDoc(workspacePath)
  } catch (error) {
    if (error instanceof WorkspaceFileError) return null
    throw error
  }
  if (!bytes) return null
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf-8'))
  } catch {
    return null
  }
}

/** The entries of an agent's skills directory; none when it does not exist or cannot be read. */
async function listSkillDirs(files: FileOps, agentSlug: string): Promise<FileEntry[]> {
  try {
    return await files.list(SKILLS_WORKSPACE_DIR)
  } catch (error) {
    if (!(error instanceof WorkspaceFileError)) {
      captureException(error, { tags: { area: 'skillset-reconcile', op: 'list-skills' }, extra: { agentSlug } })
    }
    return []
  }
}

/**
 * Eager sweep: walk every agent workspace and delete installed skills /
 * template metadata that aren't valid for the current auth state. Used by
 * savePlatformAuth on org switch. Safe to call when no agents exist yet.
 */
export async function reconcileInstalledForCurrentAuth(): Promise<{ skillsRemoved: number; templatesRemoved: number }> {
  let skillsRemoved = 0
  let templatesRemoved = 0

  let agents: string[]
  try {
    agents = await agentCatalog.list()
  } catch {
    return { skillsRemoved, templatesRemoved }
  }

  // One read screens every record; the prune helpers read again before each
  // deletion, so a record is only removed if it is still invalid then (the
  // org may have switched back while the sweep was running).
  const screen = await readSkillsetAuthScreen()
  if (!screen) return { skillsRemoved, templatesRemoved }

  for (const agentSlug of agents) {
    const files = agentRegistry.get(agentSlug).files

    // Installed skills
    for (const skill of await listSkillDirs(files, agentSlug)) {
      if (skill.kind !== 'directory') continue
      const parsed = await readWorkspaceJson(files, joinWorkspacePath(skill.path, SKILL_METADATA_FILE))
      if (parsed === null || providerCheckInstalled(parsed, screen)) continue
      const removed = await pruneInstalledSkillIfInvalid(parsed, files, skill.path)
      if (removed) skillsRemoved += 1
    }

    // Agent template metadata
    const parsed = await readWorkspaceJson(files, TEMPLATE_METADATA_PATH)
    if (parsed === null || providerCheckInstalled(parsed, screen)) continue
    const removed = await pruneInstalledTemplateIfInvalid(parsed, files, TEMPLATE_METADATA_PATH)
    if (removed) templatesRemoved += 1
  }

  return { skillsRemoved, templatesRemoved }
}

export type { SkillsetConfig }
