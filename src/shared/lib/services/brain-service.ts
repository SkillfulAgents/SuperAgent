import fs from 'fs'
import path from 'path'
import { assertPathWithinDir } from '@shared/lib/utils/path-safety'
import { resolveAgentId, writeFileAtomicSync } from '@shared/lib/utils/file-storage'
import {
  BRAIN_CURATOR_FILENAME,
  BRAIN_INDEX_FILENAME,
  ensureBrainDir,
} from '@shared/lib/config/data-dir'
import { getSettings } from '@shared/lib/config/settings'
import {
  PAGE_BODY_MAX_BYTES,
  pageDescription,
  pageReadSchema,
  resolveBrainPageFilename,
} from '@shared/lib/types/brain-schema'

export class BrainPageTooLargeError extends Error {
  constructor() {
    super('Page exceeds the size limit')
    this.name = 'BrainPageTooLargeError'
  }
}

export class BrainIndexProtectedError extends Error {
  constructor() {
    super('INDEX.md cannot be deleted')
    this.name = 'BrainIndexProtectedError'
  }
}

export class BrainCuratorNotFoundError extends Error {
  constructor() {
    super('Agent not found')
    this.name = 'BrainCuratorNotFoundError'
  }
}

function pagePath(name: string): { filename: string; filePath: string } | null {
  const filename = resolveBrainPageFilename(pageReadSchema.parse({ name }).name)
  if (!filename) return null
  const dir = ensureBrainDir()
  const filePath = assertPathWithinDir(dir, path.resolve(dir, filename), 'Invalid page name')
  return { filename, filePath }
}

export function readPage(name: string): {
  name: string
  description: string
  body: string
  updatedAt: string
} | null {
  const resolved = pagePath(name)
  if (!resolved) return null
  try {
    const stat = fs.statSync(resolved.filePath)
    if (!stat.isFile()) return null
    if (stat.size > PAGE_BODY_MAX_BYTES) throw new BrainPageTooLargeError()
    const body = fs.readFileSync(resolved.filePath, 'utf8')
    return {
      name: resolved.filename,
      description: pageDescription(body),
      body,
      updatedAt: stat.mtime.toISOString(),
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export function writePage(name: string, body: string): { name: string; updatedAt: string } {
  const resolved = pagePath(name)
  if (!resolved) throw new Error('Invalid page name')
  if (Buffer.byteLength(body, 'utf8') > PAGE_BODY_MAX_BYTES) throw new BrainPageTooLargeError()
  writeFileAtomicSync(resolved.filePath, body)
  return {
    name: resolved.filename,
    updatedAt: fs.statSync(resolved.filePath).mtime.toISOString(),
  }
}

export function deletePage(name: string): { name: string } | null {
  const resolved = pagePath(name)
  if (!resolved) return null
  if (resolved.filename === BRAIN_INDEX_FILENAME) throw new BrainIndexProtectedError()
  try {
    fs.unlinkSync(resolved.filePath)
    return { name: resolved.filename }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function curatorPath(): string {
  const dir = ensureBrainDir()
  return assertPathWithinDir(dir, path.resolve(dir, BRAIN_CURATOR_FILENAME), 'Invalid curator path')
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
