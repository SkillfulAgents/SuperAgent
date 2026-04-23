import * as fs from 'fs'
import * as path from 'path'
import { getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'

const ARTIFACT_SCREENSHOT_FILENAME = 'screenshot.png'

export interface ArtifactInfo {
  slug: string
  name: string
  description: string
  status: 'running' | 'stopped' | 'crashed' | 'starting'
  port: number
  hasScreenshot?: boolean
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

  const dashboards: ArtifactInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const pkgPath = path.join(artifactsDir, entry.name, 'package.json')
    try {
      const pkgContent = await fs.promises.readFile(pkgPath, 'utf-8')
      const pkg = JSON.parse(pkgContent)
      const screenshotPath = path.join(
        artifactsDir,
        entry.name,
        ARTIFACT_SCREENSHOT_FILENAME
      )
      const hasScreenshot = await fileExists(screenshotPath)
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
      dashboards.push(info)
    } catch {
      // No valid package.json, skip
    }
  }

  return dashboards
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.R_OK)
    return true
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
  if (!resolved.startsWith(path.resolve(artifactsDir) + path.sep)) {
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
  await fs.promises.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
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
  if (!resolved.startsWith(path.resolve(artifactsDir) + path.sep)) {
    throw new Error('Invalid artifact slug')
  }

  await fs.promises.rm(artifactDir, { recursive: true, force: true })
}
