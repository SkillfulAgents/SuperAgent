/**
 * Keeps a skillset's cache folder in the blob store, so a process that starts with an empty
 * data dir restores it instead of downloading the skillset again. The folder is
 * packed into one blob: one read restores it. `.git` is never packed: a git cache that is not
 * on disk is cloned again, as before.
 *
 * A process whose file system is empty on every request restores on every request, so it keeps
 * the decoded files of the version it last read: a skillset blob can be several MB, and fetching
 * and decoding it each time costs more than the request itself. Each restore reads the small
 * version marker first, so a save or a delete in another process is seen on the next restore.
 */
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { blobStore } from '@shared/lib/blob-store/blob-store'

interface PackedFile {
  path: string
  /** base64 */
  data: string
  mode: number
}

/** Not `skillset-cache/`: in the data dir that is the cache folder itself. */
const keyFor = (repoDir: string) => `skillset-cache-packs/${path.basename(repoDir)}`
/** Written after the folder's blob, so a reader that sees a version can read that blob. */
const versionKeyFor = (key: string) => `${key}.version`

interface DecodedFile {
  path: string
  bytes: Uint8Array
  mode: number
}

const decoded = new Map<string, { version: string; files: DecodedFile[] }>()

const decode = (files: PackedFile[]): DecodedFile[] => files.map((file) => ({ path: file.path, bytes: Buffer.from(file.data, 'base64'), mode: file.mode }))

async function storedFiles(key: string): Promise<DecodedFile[] | null> {
  const store = blobStore()
  const marker = await store.get(versionKeyFor(key))
  if (!marker) return null
  const version = new TextDecoder().decode(marker)
  const kept = decoded.get(key)
  if (kept?.version === version) return kept.files
  const stored = await store.get(key)
  if (!stored) return null
  const { files } = JSON.parse(new TextDecoder().decode(stored)) as { v: 1; version: string; files: PackedFile[] }
  const result = decode(files)
  // Kept under the marker read, not the folder's own version: two saves that race can leave the
  // marker naming the other one's folder, and the next save changes the marker either way.
  decoded.set(key, { version, files: result })
  return result
}

async function collect(root: string, dir: string, out: PackedFile[]): Promise<void> {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await collect(root, full, out)
    else if (entry.isFile()) {
      const [bytes, stat] = await Promise.all([fs.promises.readFile(full), fs.promises.stat(full)])
      out.push({ path: path.relative(root, full).split(path.sep).join('/'), data: bytes.toString('base64'), mode: stat.mode & 0o777 })
    }
  }
}

export async function saveSkillsetCache(repoDir: string): Promise<void> {
  const store = blobStore()
  const files: PackedFile[] = []
  await collect(repoDir, repoDir, files)
  const key = keyFor(repoDir)
  const version = randomUUID()
  await store.put(key, new TextEncoder().encode(JSON.stringify({ v: 1, version, files })))
  await store.put(versionKeyFor(key), new TextEncoder().encode(version))
  // Not kept in memory here: only a process that restores needs the decoded files.
  decoded.delete(key)
}

/** Writes the stored folder to disk; false without a stored copy. */
export async function restoreSkillsetCache(repoDir: string): Promise<boolean> {
  const files = await storedFiles(keyFor(repoDir))
  if (!files) return false
  const root = path.resolve(repoDir)
  for (const file of files) {
    const target = path.resolve(root, file.path)
    // A stored path never leaves the folder.
    if (!target.startsWith(root + path.sep)) continue
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(target, file.bytes, { mode: file.mode })
  }
  return true
}

export async function deleteSkillsetCache(repoDir: string): Promise<void> {
  const key = keyFor(repoDir)
  decoded.delete(key)
  const store = blobStore()
  // The marker first: once it is gone, no process restores the folder.
  await store.delete(versionKeyFor(key))
  await store.delete(key)
}
