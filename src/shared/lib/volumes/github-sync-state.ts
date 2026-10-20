import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { getDataDir } from '@shared/lib/config/data-dir'
import { writeJsonFileAtomic } from '@shared/lib/utils/file-storage'
import { githubSyncStateSchema, type SyncState } from './github-schema'

export function volumeFolder(id: string): string {
  return path.join(getDataDir(), 'volumes', id)
}

export function emptySyncState(): SyncState {
  return { version: 1, base: null, files: {} }
}

export async function loadSyncState(folder: string): Promise<SyncState> {
  try { return githubSyncStateSchema.parse(JSON.parse(await fs.readFile(path.join(folder, 'sync.json'), 'utf8'))) }
  catch { return emptySyncState() }
}

export async function saveSyncState(folder: string, state: SyncState): Promise<void> {
  await fs.mkdir(folder, { recursive: true })
  await writeJsonFileAtomic(path.join(folder, 'sync.json'), githubSyncStateSchema.parse(state))
}

export function blobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

export async function fileBlobSha(file: string): Promise<string> {
  const stat = await fs.lstat(file)
  const hash = createHash('sha1').update(`blob ${stat.size}\0`)
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export function snapshotCollisions(paths: string[], caseInsensitive: boolean): string[][] {
  const names = new Map<string, Set<string>>()
  for (const name of paths) {
    const parts = name.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('/')
      const key = caseInsensitive ? path.normalize('NFC').toLowerCase() : path
      const aliases = names.get(key) ?? new Set<string>()
      aliases.add(path)
      names.set(key, aliases)
    }
  }
  return [...names.values()].filter(names => names.size > 1).map(names => [...names])
}
