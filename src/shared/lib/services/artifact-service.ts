import { agentRegistry, joinWorkspacePath } from '@shared/lib/agent-actor'
import { ARTIFACT_MANIFEST_FILENAME, artifactPath, scanArtifactsIn, type ArtifactInfo } from './artifact-scan'

/**
 * List dashboard artifacts for an agent from its workspace.
 * Used when the container is not running (all dashboards reported as 'stopped').
 */
export async function listArtifactsFromFilesystem(
  agentSlug: string
): Promise<ArtifactInfo[]> {
  return (await scanArtifactsIn(agentRegistry.get(agentSlug).files, { includeWidgets: false, agentSlug })).dashboards
}

/**
 * Workspace path of one artifact's directory. The slug has to be a plain
 * directory name under the rule the container's dashboard manager applies to
 * every artifact it creates; anything else is a bad slug, answered here rather
 * than handed to the actor as a path.
 */
function artifactDirFor(agentSlug: string, artifactSlug: string): string {
  const dir = artifactPath(artifactSlug)
  if (dir === null) throw new Error('Invalid artifact slug')
  return dir
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
