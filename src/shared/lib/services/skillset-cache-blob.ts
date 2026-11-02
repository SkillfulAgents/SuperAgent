/**
 * Keeps a skillset's cache folder in the deployment's blob store, so a process that starts
 * with an empty data dir restores it instead of downloading the skillset again. The folder is
 * packed into one blob: one read restores it. `.git` is never packed: a git cache that is not
 * on disk is cloned again, as before.
 *
 * A process whose file system is empty on every request restores on every request, so the
 * decoded files are also kept in memory for a while: a skillset blob can be several MB, and
 * fetching and decoding it each time costs more than the request itself.
 */
import fs from 'fs'
import path from 'path'
import { blobStore } from '@shared/lib/blob-store/blob-store'

interface PackedFile {
  path: string
  /** base64 */
  data: string
  mode: number
}

const keyFor = (repoDir: string) => `skillset-cache/${path.basename(repoDir)}`

interface DecodedFile {
  path: string
  bytes: Uint8Array
  mode: number
}

/** As long as a background refresh may reuse a cache (BACKGROUND_SKILLSET_REFRESH_MAX_AGE_MS). */
const MEMORY_TTL_MS = 15 * 60_000
const decoded = new Map<string, { at: number; files: DecodedFile[] }>()

const decode = (files: PackedFile[]): DecodedFile[] => files.map((file) => ({ path: file.path, bytes: Buffer.from(file.data, 'base64'), mode: file.mode }))

async function storedFiles(key: string): Promise<DecodedFile[] | null> {
  const kept = decoded.get(key)
  if (kept && Date.now() - kept.at < MEMORY_TTL_MS) return kept.files
  const stored = await blobStore()?.get(key)
  if (!stored) return null
  const { files } = JSON.parse(new TextDecoder().decode(stored)) as { v: 1; files: PackedFile[] }
  const result = decode(files)
  decoded.set(key, { at: Date.now(), files: result })
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

/** Saves the folder to the blob store; a no-op without a store. */
export async function saveSkillsetCache(repoDir: string): Promise<void> {
  const store = blobStore()
  if (!store) return
  const files: PackedFile[] = []
  await collect(repoDir, repoDir, files)
  await store.put(keyFor(repoDir), new TextEncoder().encode(JSON.stringify({ v: 1, files })))
  decoded.set(keyFor(repoDir), { at: Date.now(), files: decode(files) })
}

/** Writes the stored folder to disk; false without a store or a stored copy. */
export async function restoreSkillsetCache(repoDir: string): Promise<boolean> {
  if (!blobStore()) return false
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
  decoded.delete(keyFor(repoDir))
  await blobStore()?.delete(keyFor(repoDir))
}
