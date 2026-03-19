import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { getAgentDir } from '@shared/lib/utils/file-storage'
import type { AgentMount, AgentMountWithHealth } from '@shared/lib/types/mount'

function getMountsFilePath(slug: string): string {
  return path.join(getAgentDir(slug), 'mounts.json')
}

export function getMounts(slug: string): AgentMount[] {
  const filePath = getMountsFilePath(slug)
  try {
    const data = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

function writeMounts(slug: string, mounts: AgentMount[]): void {
  const filePath = getMountsFilePath(slug)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(mounts, null, 2))
}

export function addMount(slug: string, hostPath: string): AgentMount {
  if (!path.isAbsolute(hostPath)) {
    throw new Error('hostPath must be an absolute path')
  }
  const resolved = fs.realpathSync(hostPath)
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error('hostPath must be a directory')
  }

  const mounts = getMounts(slug)
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
  const mounts = getMounts(slug)
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
