import pLimit from 'p-limit'
import { agentRegistry, joinWorkspacePath, type FileEntry } from '@shared/lib/agent-actor'
import type { ApiAgentWidget } from '@shared/lib/widgets/widget-schema'
import {
  artifactsDirFor,
  describeWidgetFromManifest,
  isMissingDirectoryError,
  isWidgetOnlyArtifact,
  isWidgetSlug,
  containedArtifactPath,
} from './widget-service'

const ARTIFACT_MANIFEST_FILENAME = 'package.json'
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
 * List dashboard artifacts for an agent from its workspace.
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
 * that copy. Listing the two separately doubled the listing and the manifest
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
  const files = agentRegistry.get(agentSlug).files

  // Where the artifacts really are: a link the agent planted in place of the
  // directory reads as no artifacts, as it always has.
  const artifactsDir = await containedArtifactPath(agentSlug, artifactsDirFor(agentSlug))
  if (artifactsDir === null) return { dashboards: [], widgets: [] }
  let entries: FileEntry[]
  try {
    entries = await files.list(artifactsDir)
  } catch (error) {
    // No artifacts directory yet: nothing to list. Any other failure reads the
    // same way: this runs for every agent on every agents-list poll, and one
    // agent's unreadable directory must not take the whole list down.
    if (!isMissingDirectoryError(error)) {
      console.warn(`[artifact-service] Could not list artifacts for ${agentSlug}; treating as none:`, error)
    }
    return { dashboards: [], widgets: [] }
  }

  // Three independent lookups per artifact, artifacts independent of each
  // other: issue them concurrently instead of one round trip at a time —
  // this runs for every agent on every agents-list poll. The limiter bounds
  // individual probes, not artifacts: wrapping the artifact would let each
  // slot fan out to three probes, and an artifact that gives up early (no
  // package.json) would free its slot while its two siblings still ran.
  // Result order follows the directory listing, as before.
  const limit = pLimit(10)
  // One clock for the whole scan, so two widgets never disagree about staleness.
  const now = Date.now()
  const scanned = await Promise.all(
    entries
      .filter((entry) => entry.kind === 'directory')
      .map(async (entry): Promise<{ dashboard: ArtifactInfo | null; widget: ApiAgentWidget | null }> => {
        const nothing = { dashboard: null, widget: null }
        // One artifact dir at a time, as it really is; a link out of the
        // workspace is no artifact.
        const dir = await limit(() => containedArtifactPath(agentSlug, entry.path))
        if (dir === null) return nothing
        let pkg: { name?: unknown; description?: unknown }
        let hasScreenshot: boolean
        let hasNodeModules: boolean
        try {
          const [manifest, screenshot, nodeModules] = await Promise.all([
            limit(() => files.getDoc(joinWorkspacePath(dir, ARTIFACT_MANIFEST_FILENAME))),
            limit(() => files.stat(joinWorkspacePath(dir, ARTIFACT_SCREENSHOT_FILENAME))),
            limit(() => files.stat(joinWorkspacePath(dir, 'node_modules'))),
          ])
          if (manifest === null) return nothing
          pkg = JSON.parse(new TextDecoder().decode(manifest))
          hasScreenshot = screenshot?.kind === 'file'
          hasNodeModules = nodeModules?.kind === 'directory'
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

/**
 * Workspace path of one artifact's directory. The slug has to be a plain
 * directory name under the rule the container's dashboard manager applies to
 * every artifact it creates; anything else is a bad slug, answered here rather
 * than handed to the actor as a path.
 */
function artifactDirFor(agentSlug: string, artifactSlug: string): string {
  if (!isWidgetSlug(artifactSlug)) throw new Error('Invalid artifact slug')
  return joinWorkspacePath(artifactsDirFor(agentSlug), artifactSlug)
}

/**
 * Rename a dashboard artifact by updating its package.json name field.
 */
export async function renameArtifactOnFilesystem(
  agentSlug: string,
  artifactSlug: string,
  newName: string
): Promise<void> {
  const manifestPath = joinWorkspacePath(artifactDirFor(agentSlug, artifactSlug), ARTIFACT_MANIFEST_FILENAME)
  const files = agentRegistry.get(agentSlug).files

  const manifest = await files.getDoc(manifestPath)
  if (manifest === null) throw new Error(`No such file: ${manifestPath}`)
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(new TextDecoder().decode(manifest))
  } catch {
    throw new Error(`Failed to parse ${manifestPath}`)
  }
  pkg.name = newName
  // Atomic write: the read already throws on a corrupt package.json,
  // so this never overwrites with a default — just make the write crash-safe.
  await files.putDoc(manifestPath, JSON.stringify(pkg, null, 2) + '\n')
}

/**
 * Delete a dashboard artifact by removing its directory from the workspace.
 */
export async function deleteArtifactFromFilesystem(
  agentSlug: string,
  artifactSlug: string
): Promise<void> {
  await agentRegistry.get(agentSlug).files.delete(artifactDirFor(agentSlug, artifactSlug), { recursive: true })
}
