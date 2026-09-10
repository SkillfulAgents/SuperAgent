import * as fs from 'fs'
import * as path from 'path'
import pLimit from 'p-limit'
import { getAgentWorkspaceDir, writeFileAtomic } from '@shared/lib/utils/file-storage'
import { isPathWithinDir } from '@shared/lib/utils/path-safety'
import type { ApiAgentWidget } from '@shared/lib/widgets/widget-schema'
import { describeWidgetFromManifest, isWidgetSlug, isWidgetOnlyArtifact } from './widget-service'

const ARTIFACT_SCREENSHOT_FILENAME = 'screenshot.png'

export interface ArtifactInfo {
  slug: string
  name: string
  description: string
  status: 'running' | 'stopped' | 'crashed' | 'starting'
  port: number
  hasScreenshot?: boolean
  startupPhase?: 'installing-dependencies' | 'starting-server'
  firstRun?: boolean
}

/** Both halves of an agent's artifacts, from one scan. */
export interface ArtifactListing {
  dashboards: ArtifactInfo[]
  widgets: ApiAgentWidget[]
}

/**
 * List dashboard artifacts for an agent by reading the host filesystem.
 * Used when the container is not running (all dashboards reported as 'stopped').
 */
export async function listArtifactsFromFilesystem(
  agentSlug: string
): Promise<ArtifactInfo[]> {
  return (await scanArtifacts(agentSlug, { includeWidgets: false })).dashboards
}

/**
 * Both halves of every artifact, from a single directory scan.
 *
 * An artifact's package.json decides whether it is a dashboard, a widget or
 * both, so the agents-list path reads it ONCE and answers both questions from
 * that copy. Listing the two separately doubled the readdir and the manifest
 * read of every artifact of every agent on every poll — including the warm
 * iOS poll, which is meant to be nearly free.
 */
export async function listArtifactsAndWidgets(agentSlug: string): Promise<ArtifactListing> {
  return scanArtifacts(agentSlug, { includeWidgets: true })
}

async function scanArtifacts(
  agentSlug: string,
  opts: { includeWidgets: boolean },
): Promise<ArtifactListing> {
  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  const artifactsDir = path.join(workspaceDir, 'artifacts')

  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(artifactsDir, { withFileTypes: true })
  } catch {
    return { dashboards: [], widgets: [] }
  }
  // Test doubles of fs resolve readdir with nothing; treat that as no artifacts.
  if (!Array.isArray(entries)) return { dashboards: [], widgets: [] }

  // Three independent lookups per artifact, artifacts independent of each
  // other: issue them concurrently instead of one round trip at a time —
  // this runs for every agent on every agents-list poll. The limiter bounds
  // individual filesystem probes, not artifacts: wrapping the artifact would
  // let each slot fan out to three probes, and a missing package.json would
  // reject the group and free the slot while its two siblings still ran.
  // Result order follows the directory listing, as before.
  const limit = pLimit(10)
  // One clock for the whole scan, so two widgets never disagree about staleness.
  const now = Date.now()
  const scanned = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<{ dashboard: ArtifactInfo | null; widget: ApiAgentWidget | null }> => {
        const artifactDir = path.join(artifactsDir, entry.name)
        const nothing = { dashboard: null, widget: null }
        let pkg: { name?: unknown; description?: unknown }
        let hasScreenshot: boolean
        let hasNodeModules: boolean
        try {
          const [pkgContent, screenshot, nodeModules] = await Promise.all([
            limit(() => fs.promises.readFile(path.join(artifactDir, 'package.json'), 'utf-8')),
            limit(() => fileExists(path.join(artifactDir, ARTIFACT_SCREENSHOT_FILENAME))),
            limit(() => directoryExists(path.join(artifactDir, 'node_modules'))),
          ])
          pkg = JSON.parse(pkgContent)
          hasScreenshot = screenshot
          hasNodeModules = nodeModules
        } catch {
          // No valid package.json, skip
          return nothing
        }

        // The widget half needs its own snapshot state, but not another
        // manifest read — it is handed the copy above.
        const widget = opts.includeWidgets && isWidgetSlug(entry.name)
          ? await describeWidgetFromManifest(agentSlug, entry.name, pkg, now)
          : null

        // A widget-only artifact has no server; it is listed as a widget only.
        if (isWidgetOnlyArtifact(pkg)) return { dashboard: null, widget }

        const info: ArtifactInfo = {
          slug: entry.name,
          name: (typeof pkg.name === 'string' && pkg.name) || entry.name,
          description: (typeof pkg.description === 'string' && pkg.description) || '',
          status: 'stopped',
          port: 0,
        }
        // Only include hasScreenshot when true — keeps the API shape minimal
        // and avoids spurious `hasScreenshot: false` fields in common responses.
        if (hasScreenshot) info.hasScreenshot = true
        // The host can report this before the agent container is running. That
        // lets the dashboard view explain first-run preparation during container
        // startup instead of flashing the state only during a fast install.
        if (!hasNodeModules) info.firstRun = true
        return { dashboard: info, widget }
      }),
  )

  return {
    dashboards: scanned.map((r) => r.dashboard).filter((info): info is ArtifactInfo => info !== null),
    widgets: scanned.map((r) => r.widget).filter((w): w is ApiAgentWidget => w !== null),
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function directoryExists(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Rename a dashboard artifact by updating its package.json name field.
 */
export async function renameArtifactOnFilesystem(
  agentSlug: string,
  artifactSlug: string,
  newName: string
): Promise<void> {
  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  const artifactDir = path.join(workspaceDir, 'artifacts', artifactSlug)

  // Ensure the path is within the expected artifacts directory
  const artifactsDir = path.join(workspaceDir, 'artifacts')
  const resolved = path.resolve(artifactDir)
  if (!isPathWithinDir(artifactsDir, resolved)) {
    throw new Error('Invalid artifact slug')
  }

  const pkgPath = path.join(artifactDir, 'package.json')
  const pkgContent = await fs.promises.readFile(pkgPath, 'utf-8')
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(pkgContent)
  } catch {
    throw new Error(`Failed to parse ${pkgPath}`)
  }
  pkg.name = newName
  // Atomic write: the read already throws on a corrupt package.json,
  // so this never overwrites with a default — just make the write crash-safe.
  await writeFileAtomic(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
}

/**
 * Delete a dashboard artifact by removing its directory from the host filesystem.
 */
export async function deleteArtifactFromFilesystem(
  agentSlug: string,
  artifactSlug: string
): Promise<void> {
  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  const artifactDir = path.join(workspaceDir, 'artifacts', artifactSlug)

  // Ensure the path is within the expected artifacts directory
  const artifactsDir = path.join(workspaceDir, 'artifacts')
  const resolved = path.resolve(artifactDir)
  if (!isPathWithinDir(artifactsDir, resolved)) {
    throw new Error('Invalid artifact slug')
  }

  await fs.promises.rm(artifactDir, { recursive: true, force: true })
}
