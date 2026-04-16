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
 * Typical callers:
 *  - `savePlatformAuth` on org switch / disconnect — eager full sweep
 *  - metadata readers on access — lazy backstop
 */

import fs from 'fs'
import path from 'path'
import { getSettings, updateSettings } from '@shared/lib/config/settings'
import { getSkillsetProvider } from '@shared/lib/skillset-provider'
import {
  getAgentsDir,
  getAgentWorkspaceDir,
  readFileOrNull,
} from '@shared/lib/utils/file-storage'
import { captureException } from '@shared/lib/error-reporting'
import type {
  InstalledAgentMetadata,
  InstalledSkillMetadata,
  SkillsetConfig,
} from '@shared/lib/types/skillset'

export interface InstalledSkillLocation {
  agentSlug: string
  skillDirName: string
  skillDir: string
  metaPath: string
}

export interface InstalledTemplateLocation {
  agentSlug: string
  workspaceDir: string
  metaPath: string
}

/**
 * Filter out SkillsetConfig entries that are no longer valid for the current
 * auth state. Mutates settings.skillsets and persists if anything changed.
 */
export function reconcileSkillsetConfigsForCurrentAuth(): { removed: number } {
  const settings = getSettings()
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
  if (kept.length !== before.length) {
    settings.skillsets = kept
    updateSettings(settings)
  }
  return { removed: before.length - kept.length }
}

function readInstalledSkillMetaRaw(metaPath: string): unknown {
  const raw = fs.readFileSync(metaPath, 'utf-8')
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
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
 * object and its location, delete the skill directory if the provider says
 * the record is no longer valid. Returns true if a cleanup happened.
 */
export async function pruneInstalledSkillIfInvalid(
  meta: unknown,
  skillDir: string,
): Promise<boolean> {
  if (providerCheckInstalled(meta)) return false
  try {
    await fs.promises.rm(skillDir, { recursive: true, force: true })
  } catch (error) {
    captureException(error, { tags: { area: 'skillset-reconcile', op: 'rm-skill' } })
  }
  return true
}

/**
 * Lazy-cleanup helper for agent-template metadata readers.
 */
export async function pruneInstalledTemplateIfInvalid(
  meta: unknown,
  metaPath: string,
): Promise<boolean> {
  if (providerCheckInstalled(meta)) return false
  try {
    await fs.promises.unlink(metaPath)
  } catch (error) {
    captureException(error, { tags: { area: 'skillset-reconcile', op: 'unlink-template' } })
  }
  return true
}

/**
 * Eager sweep: walk every agent workspace and delete installed skills /
 * template metadata that aren't valid for the current auth state. Used by
 * savePlatformAuth on org switch. Safe to call when no agents exist yet.
 */
export async function reconcileInstalledForCurrentAuth(): Promise<{ skillsRemoved: number; templatesRemoved: number }> {
  let skillsRemoved = 0
  let templatesRemoved = 0

  const agentsRoot = getAgentsDir()
  let agentEntries: fs.Dirent[]
  try {
    agentEntries = await fs.promises.readdir(agentsRoot, { withFileTypes: true })
  } catch {
    return { skillsRemoved, templatesRemoved }
  }

  for (const agent of agentEntries) {
    if (!agent.isDirectory()) continue
    const workspaceDir = getAgentWorkspaceDir(agent.name)

    // Installed skills
    const skillsDir = path.join(workspaceDir, '.claude', 'skills')
    let skillDirs: fs.Dirent[]
    try {
      skillDirs = await fs.promises.readdir(skillsDir, { withFileTypes: true })
    } catch {
      skillDirs = []
    }
    for (const skill of skillDirs) {
      if (!skill.isDirectory()) continue
      const metaPath = path.join(skillsDir, skill.name, '.skillset-metadata.json')
      const raw = await readFileOrNull(metaPath)
      if (!raw) continue
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { continue }
      const removed = await pruneInstalledSkillIfInvalid(parsed, path.join(skillsDir, skill.name))
      if (removed) skillsRemoved += 1
    }

    // Agent template metadata
    const templateMetaPath = path.join(workspaceDir, '.skillset-agent-metadata.json')
    const raw = await readFileOrNull(templateMetaPath)
    if (!raw) continue
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { continue }
    const removed = await pruneInstalledTemplateIfInvalid(parsed, templateMetaPath)
    if (removed) templatesRemoved += 1
  }

  return { skillsRemoved, templatesRemoved }
}

// Re-export for tests
export { readInstalledSkillMetaRaw as __readInstalledSkillMetaRaw }

export type { SkillsetConfig }
