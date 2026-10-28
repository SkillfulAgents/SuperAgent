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

import { mutateSettings } from '@shared/lib/config/settings'
import { getSkillsetProvider } from '@shared/lib/skillset-provider'
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
export function reconcileSkillsetConfigsForCurrentAuth(): { removed: number } {
  // Filter against a FRESH read inside the serialized mutation so a concurrent
  // add/remove of an unrelated skillset isn't lost.
  let removed = 0
  mutateSettings((settings) => {
    const before = settings.skillsets ?? []
    const kept = before.filter((c) => {
      try {
        return getSkillsetProvider(c.provider).isConfigValid(c)
      } catch (error) {
        captureException(error, { tags: { area: 'skillset-reconcile', op: 'isConfigValid' } })
        // Fail-open: if the provider check throws, keep the config so we don't
        // mass-delete on a transient error.
        return true
      }
    })
    removed = before.length - kept.length
    settings.skillsets = kept
  })
  return { removed }
}

function providerCheckInstalled(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') return true
  const m = meta as Partial<Pick<InstalledSkillMetadata | InstalledAgentMetadata,
    'provider' | 'providerData'>>
  try {
    return getSkillsetProvider(m.provider).isInstalledValid(m)
  } catch (error) {
    captureException(error, { tags: { area: 'skillset-reconcile', op: 'isInstalledValid' } })
    return true
  }
}

/**
 * Lazy-cleanup helper for skill metadata readers. Given a parsed metadata
 * object and the skill directory's workspace path, delete the directory if
 * the provider says the record is no longer valid. Returns true if a cleanup
 * happened.
 */
export async function pruneInstalledSkillIfInvalid(
  meta: unknown,
  files: FileOps,
  skillDir: string,
): Promise<boolean> {
  if (providerCheckInstalled(meta)) return false
  try {
    await files.delete(skillDir, { recursive: true })
  } catch (error) {
    captureException(error, { tags: { area: 'skillset-reconcile', op: 'rm-skill' } })
  }
  return true
}

/**
 * Lazy-cleanup helper for agent-template metadata readers: `metaPath` is the
 * metadata file's workspace path.
 */
export async function pruneInstalledTemplateIfInvalid(
  meta: unknown,
  files: FileOps,
  metaPath: string,
): Promise<boolean> {
  if (providerCheckInstalled(meta)) return false
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

  for (const agentSlug of agents) {
    const files = agentRegistry.get(agentSlug).files

    // Installed skills
    for (const skill of await listSkillDirs(files, agentSlug)) {
      if (skill.kind !== 'directory') continue
      const parsed = await readWorkspaceJson(files, joinWorkspacePath(skill.path, SKILL_METADATA_FILE))
      if (parsed === null) continue
      const removed = await pruneInstalledSkillIfInvalid(parsed, files, skill.path)
      if (removed) skillsRemoved += 1
    }

    // Agent template metadata
    const parsed = await readWorkspaceJson(files, TEMPLATE_METADATA_PATH)
    if (parsed === null) continue
    const removed = await pruneInstalledTemplateIfInvalid(parsed, files, TEMPLATE_METADATA_PATH)
    if (removed) templatesRemoved += 1
  }

  return { skillsRemoved, templatesRemoved }
}

export type { SkillsetConfig }
