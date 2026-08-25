import fs from 'fs'
import path from 'path'
import { resolveAgentId, writeFileAtomicSync } from '@shared/lib/utils/file-storage'
import { BRAIN_CURATOR_FILENAME, ensureBrainDir } from '@shared/lib/config/data-dir'
import { getSettings } from '@shared/lib/config/settings'

export class BrainCuratorNotFoundError extends Error {
  constructor() {
    super('Agent not found')
    this.name = 'BrainCuratorNotFoundError'
  }
}

function curatorPath(): string {
  return path.join(ensureBrainDir(), BRAIN_CURATOR_FILENAME)
}

export function isTeamBrainEnabled(): boolean {
  return getSettings().teamBrain === true
}

export function getCuratorSlug(): string | null {
  try {
    const slug = fs.readFileSync(curatorPath(), 'utf8').trim()
    return slug.length > 0 ? slug : null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function setCuratorSlug(agentSlug: string | null): Promise<string | null> {
  if (agentSlug === null) {
    try {
      fs.unlinkSync(curatorPath())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    return null
  }
  const resolved = await resolveAgentId(agentSlug)
  if (!resolved) throw new BrainCuratorNotFoundError()
  writeFileAtomicSync(curatorPath(), resolved)
  return resolved
}

export function clearCuratorIfSlug(agentSlug: string): void {
  if (getCuratorSlug() === agentSlug) void setCuratorSlug(null)
}
