import path from 'path'
import os from 'os'
import fs from 'fs'
import crypto from 'crypto'
import {
  getAgentDir,
  readJsonFileStrictSync,
  writeJsonFileAtomicSync,
  CorruptFileError,
} from '@shared/lib/utils/file-storage'
import { isPathWithinDir } from '@shared/lib/utils/path-safety'
import { captureException } from '@shared/lib/error-reporting'
import type { AgentMount, AgentMountWithHealth } from '@shared/lib/types/mount'
import { agentMountsSchema } from './mount-schema'

function getMountsFilePath(slug: string): string {
  return path.join(getAgentDir(slug), 'mounts.json')
}

/**
 * Strict read for the read-modify-write paths (addMount/removeMount): an absent
 * file is `[]`, but a corrupt/torn `mounts.json` or IO error THROWS so the write
 * aborts instead of clobbering the file with just the new/remaining mount (the
 * previous catch-all swallowed bad reads, so the next write dropped every prior
 * mount). Do NOT use this on read-only display paths — use {@link getMounts}.
 */
function readMountsStrict(slug: string): AgentMount[] {
  return readJsonFileStrictSync(getMountsFilePath(slug), agentMountsSchema, [])
}

/**
 * Read the agent's mounts for READ-ONLY consumers (the mounts UI, health checks,
 * and CONTAINER START). Tolerant: an absent file is `[]`, and a corrupt/unreadable
 * file degrades to `[]` (logged + captured) rather than throwing — a bad
 * mounts.json must not brick `getMountsWithHealth` (which runs on every container
 * start) or 500 the mounts route. This never writes, so degrading to `[]` is safe;
 * writes go through addMount/removeMount, which use the strict read and abort on
 * corruption instead of overwriting.
 */
export function getMounts(slug: string): AgentMount[] {
  try {
    return readMountsStrict(slug)
  } catch (error) {
    if (error instanceof CorruptFileError) {
      console.error(`Corrupt mounts.json for agent ${slug}; treating as no mounts (NOT overwriting)`, error)
      captureException(error, { tags: { area: 'mounts', op: 'read' }, extra: { agentSlug: slug } })
      return []
    }
    throw error
  }
}

/**
 * Cloud-synced directories that macOS File Providers manage (iCloud Drive,
 * Dropbox, OneDrive, Google Drive, etc.). The Electron app can read these
 * because it has the user's TCC grant, but the Lima VM helper process does
 * NOT — macOS denies it with EPERM when the container runtime stats the path,
 * so the mount can't be shared into the agent sandbox. A host accessSync still
 * passes for the app, so we detect these by path prefix instead.
 */
function getCloudStoragePrefixes(): string[] {
  const home = os.homedir()
  return [
    // iCloud Drive
    path.join(home, 'Library', 'Mobile Documents'),
    // Third-party File Provider storage (Dropbox, OneDrive, Google Drive, …)
    path.join(home, 'Library', 'CloudStorage'),
  ]
}

/**
 * Detect whether a host path lives inside a cloud-synced directory that can't
 * be shared into the agent sandbox. Returns true on macOS for iCloud Drive and
 * `~/Library/CloudStorage/...` File Provider paths.
 */
export function isCloudStoragePath(hostPath: string): boolean {
  if (process.platform !== 'darwin') return false
  const normalized = path.resolve(hostPath)
  return getCloudStoragePrefixes().some((prefix) => isPathWithinDir(prefix, normalized))
}

/** User-facing message shown when a cloud-synced folder is rejected as a mount. */
export const CLOUD_MOUNT_MESSAGE =
  'This folder is in iCloud Drive or a cloud-synced location (Dropbox, OneDrive, Google Drive), ' +
  'which can’t be shared into the agent sandbox. Please copy it to a regular local folder ' +
  '(e.g. somewhere under your home directory) and mount that instead.'

function writeMounts(slug: string, mounts: AgentMount[]): void {
  const filePath = getMountsFilePath(slug)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  // Atomic temp-file + rename: an interrupted write can never truncate
  // mounts.json into the half-state the old reader would have swallowed.
  writeJsonFileAtomicSync(filePath, agentMountsSchema.parse(mounts))
}

export function addMount(slug: string, hostPath: string): AgentMount {
  if (!path.isAbsolute(hostPath)) {
    throw new Error('hostPath must be an absolute path')
  }
  // Reject cloud-synced folders before the user hits a cryptic run-time failure:
  // the Lima VM helper can't stat File Provider paths even though the app can.
  // Check the user-supplied path AND its realpath — iCloud aliases can resolve
  // out of the cloud prefix, but the cloud prefix itself is the reliable signal.
  if (isCloudStoragePath(hostPath)) {
    throw new Error(CLOUD_MOUNT_MESSAGE)
  }
  const resolved = fs.realpathSync(hostPath)
  if (isCloudStoragePath(resolved)) {
    throw new Error(CLOUD_MOUNT_MESSAGE)
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error('hostPath must be a directory')
  }

  const mounts = readMountsStrict(slug)
  const baseName = path.basename(resolved)

  // Pick container path, append -2, -3, etc. on collision
  let containerName = baseName
  let suffix = 2
  while (mounts.some((m) => m.containerPath === `/mounts/${containerName}`)) {
    containerName = `${baseName}-${suffix}`
    suffix++
  }

  const mount: AgentMount = {
    id: crypto.randomUUID(),
    hostPath: resolved,
    containerPath: `/mounts/${containerName}`,
    folderName: baseName,
    addedAt: new Date().toISOString(),
  }

  mounts.push(mount)
  writeMounts(slug, mounts)
  return mount
}

export function removeMount(slug: string, mountId: string): void {
  const mounts = readMountsStrict(slug)
  const filtered = mounts.filter((m) => m.id !== mountId)
  writeMounts(slug, filtered)
}

export function getMountsWithHealth(slug: string): AgentMountWithHealth[] {
  const mounts = getMounts(slug)
  return mounts.map((m) => ({
    ...m,
    health: fs.existsSync(m.hostPath) ? 'ok' : 'missing',
  }))
}
