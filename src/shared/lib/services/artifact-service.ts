import * as fs from 'fs'
import * as path from 'path'
import pLimit from 'p-limit'
import { getAgentWorkspaceDir, writeFileAtomic } from '@shared/lib/utils/file-storage'
import { isPathWithinDir } from '@shared/lib/utils/path-safety'

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

/**
 * List dashboard artifacts for an agent by reading the host filesystem.
 * Used when the container is not running (all dashboards reported as 'stopped').
 */
export async function listArtifactsFromFilesystem(
  agentSlug: string
): Promise<ArtifactInfo[]> {
  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  const artifactsDir = path.join(workspaceDir, 'artifacts')

  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(artifactsDir, { withFileTypes: true })
  } catch {
    return []
  }

  // Three independent lookups per artifact, artifacts independent of each
  // other: issue them concurrently (bounded) instead of one round trip at a
  // time — this runs for every agent on every agents-list poll. Result order
  // follows the directory listing, as before.
  const limit = pLimit(10)
  const dashboards = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => limit(async (): Promise<ArtifactInfo | null> => {
        const artifactDir = path.join(artifactsDir, entry.name)
        try {
          const [pkgContent, hasScreenshot, hasNodeModules] = await Promise.all([
            fs.promises.readFile(path.join(artifactDir, 'package.json'), 'utf-8'),
            fileExists(path.join(artifactDir, ARTIFACT_SCREENSHOT_FILENAME)),
            directoryExists(path.join(artifactDir, 'node_modules')),
          ])
          const pkg = JSON.parse(pkgContent)
          const info: ArtifactInfo = {
            slug: entry.name,
            name: pkg.name || entry.name,
            description: pkg.description || '',
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
          return info
        } catch {
          // No valid package.json, skip
          return null
        }
      })),
  )

  return dashboards.filter((info): info is ArtifactInfo => info !== null)
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
