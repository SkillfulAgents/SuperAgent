import * as fs from 'fs'
import * as path from 'path'
import {
  BUNDLED_AGENT_IMAGE_ARCHIVE,
  BUNDLED_AGENT_IMAGE_MANIFEST,
  bundledAgentImageSchema,
  type BundledAgentImage,
} from './bundled-agent-image-schema'

/**
 * The agent image the macOS app ships with (scripts/fetch-agent-image.ts), so
 * a new install starts its first agent without downloading it. The pull path
 * loads it instead of pulling (client-factory.ts `pullImage`); everything
 * after that — the integrity check, old-image cleanup — is the same.
 */
export interface BundledAgentImageArchive {
  path: string
  description: BundledAgentImage
}

/** OCI architecture names for the Node architectures the app ships for. */
const OCI_ARCHITECTURES: Partial<Record<NodeJS.Architecture, string>> = { arm64: 'arm64', x64: 'amd64' }

/**
 * The archive bundled for `image` on this machine, or null: no bundle
 * (Windows, dev, a build whose image wasn't published in time), or one for
 * another image, as when settings name a custom image.
 */
export function findBundledAgentImage(image: string): BundledAgentImageArchive | null {
  if (typeof process === 'undefined' || !process.resourcesPath) return null
  const dir = path.join(process.resourcesPath, 'agent-image')
  let description: BundledAgentImage
  try {
    description = bundledAgentImageSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, BUNDLED_AGENT_IMAGE_MANIFEST), 'utf8')))
  } catch {
    return null
  }
  if (description.image !== image || description.architecture !== OCI_ARCHITECTURES[process.arch]) return null
  const archive = path.join(dir, BUNDLED_AGENT_IMAGE_ARCHIVE)
  try {
    if (fs.statSync(archive).size !== description.archiveBytes) return null
  } catch {
    return null
  }
  return { path: archive, description }
}
