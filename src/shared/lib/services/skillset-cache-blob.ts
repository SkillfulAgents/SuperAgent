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
import { skillsetCacheBlobSchema, storedSkillsetIndexSchema, type PackedSkillsetFile } from './skillset-cache-blob-schema'

/** Not `skillset-cache/`: in the data dir that is the cache folder itself. */
const keyFor = (repoDir: string) => `skillset-cache-packs/${path.basename(repoDir)}`
/** Written after the folder's blob, so a reader that sees a version can read that blob. */
const versionKeyFor = (key: string) => `${key}.version`
/**
 * The folder's index.json alone, with the version it belongs to. A caller that only lists what the
 * skillset holds reads this small blob instead of the whole folder.
 */
const indexKeyFor = (key: string) => `${key}.index`
const INDEX_FILE = 'index.json'

interface DecodedFile {
  path: string
  bytes: Uint8Array
  mode: number
}

const decoded = new Map<string, { version: string; files: DecodedFile[] }>()
/** The index text of the version this process last read, kept for the same reason as `decoded`. */
const indexTexts = new Map<string, { version: string; text: string }>()

const decode = (files: PackedSkillsetFile[]): DecodedFile[] => files.map((file) => ({ path: file.path, bytes: Buffer.from(file.data, 'base64'), mode: file.mode }))

async function storedFiles(key: string): Promise<DecodedFile[] | null> {
  const store = blobStore()
  const marker = await store.get(versionKeyFor(key))
  if (!marker) return null
  const version = new TextDecoder().decode(marker)
  const kept = decoded.get(key)
  if (kept?.version === version) return kept.files
  const stored = await store.get(key)
  if (!stored) return null
  let packed
  try {
    packed = skillsetCacheBlobSchema.parse(JSON.parse(new TextDecoder().decode(stored)))
  } catch (error) {
    // An interrupted write or an unsupported pack is a cache miss. Leave the
    // stored bytes alone: another process may already be replacing them.
    decoded.delete(key)
    console.warn(`[skillsets] Ignoring invalid stored cache ${key}:`, error)
    return null
  }
  const { files } = packed
  const result = decode(files)
  // Kept under the marker read, not the folder's own version: two saves that race can leave the
  // marker naming the other one's folder, and the next save changes the marker either way.
  decoded.set(key, { version, files: result })
  return result
}

async function collect(root: string, dir: string, out: PackedSkillsetFile[]): Promise<void> {
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
  const files: PackedSkillsetFile[] = []
  await collect(repoDir, repoDir, files)
  const key = keyFor(repoDir)
  const version = randomUUID()
  const packed = skillsetCacheBlobSchema.parse({ v: 1, version, files })
  await store.put(key, new TextEncoder().encode(JSON.stringify(packed)))
  const index = files.find((file) => file.path === INDEX_FILE)
  if (index) {
    const text = Buffer.from(index.data, 'base64').toString('utf8')
    await store.put(indexKeyFor(key), new TextEncoder().encode(JSON.stringify({ version, text })))
  }
  await store.put(versionKeyFor(key), new TextEncoder().encode(version))
  // Not kept in memory here: only a process that restores needs the decoded files.
  decoded.delete(key)
  indexTexts.delete(key)
}

/**
 * The stored copy's index.json, without restoring the folder. Null when the folder exists (it is
 * then the one to read), when nothing is stored, or when the stored index is not of the stored
 * version (a copy saved before the index was stored apart): the caller then restores the folder.
 */
export async function storedSkillsetIndexText(repoDir: string): Promise<string | null> {
  try {
    await fs.promises.lstat(repoDir)
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const key = keyFor(repoDir)
  const store = blobStore()
  const marker = await store.get(versionKeyFor(key))
  if (!marker) return null
  const version = new TextDecoder().decode(marker)
  const kept = indexTexts.get(key)
  if (kept?.version === version) return kept.text
  const stored = await store.get(indexKeyFor(key))
  if (!stored) return null
  let index
  try {
    index = storedSkillsetIndexSchema.parse(JSON.parse(new TextDecoder().decode(stored)))
  } catch {
    return null
  }
  if (index.version !== version) return null
  indexTexts.set(key, index)
  return index.text
}

/** Restores an absent folder; false if it exists or no valid stored copy is available. */
export async function restoreSkillsetCache(repoDir: string): Promise<boolean> {
  // A fresh download with a missing index must fail validation, not be overlaid
  // with old files. Only an absent cache folder can use the stored copy.
  try {
    await fs.promises.lstat(repoDir)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
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
  indexTexts.delete(key)
  const store = blobStore()
  // The marker first: once it is gone, no process restores the folder.
  await store.delete(versionKeyFor(key))
  await store.delete(key)
  await store.delete(indexKeyFor(key))
}
