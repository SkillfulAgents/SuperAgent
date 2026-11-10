// Lists the workspace for a save. The save replaces the saved file list with this one, so a
// read error fails the scan: a folder or file left out would be deleted from the saved workspace.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const PARALLEL = 32

export async function inPool(items, fn) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  }))
}

export function hashFile(abs) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    fs.createReadStream(abs).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject)
  })
}

// Removed while the scan ran: no longer part of the workspace. Any other error fails the scan.
const removed = (error) => {
  if (error?.code === 'ENOENT') return null
  throw error
}

/**
 * Files, symlinks, and folders with nothing in them (a folder with something in it comes back with
 * its contents). `previous` is the last scan by path, so unchanged files are not hashed again.
 * Returns the entries and this scan by path, for the next call.
 */
export async function scan(root, excluded, previous) {
  const files = []
  const links = []
  const emptyDirs = []
  const walk = async (rel) => {
    const entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }).catch(removed)
    if (!entries) return
    let kept = 0
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (!rel && excluded.has(entry.name)) continue
      kept++
      if (entry.isSymbolicLink()) links.push(child)
      else if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) files.push(child)
    }
    if (rel && kept === 0) emptyDirs.push(rel)
  }
  await walk('')
  const scanned = new Map()
  await inPool(files, async (rel) => {
    const abs = path.join(root, rel)
    const stat = await fs.promises.stat(abs).catch(removed)
    if (!stat) return
    const known = previous.get(rel)
    // A file that changes after it is hashed is caught at upload.
    const hash = known && known.size === stat.size && known.mtimeMs === stat.mtimeMs ? known.hash : await hashFile(abs).catch(removed)
    if (hash) scanned.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs, hash, mode: stat.mode & 0o777 })
  })
  const out = [...scanned].map(([rel, f]) => ({ path: rel, hash: f.hash, size: f.size, mode: f.mode, mtimeMs: Math.round(f.mtimeMs), kind: 'file' }))
  for (const rel of links) {
    const target = await fs.promises.readlink(path.join(root, rel)).catch(removed)
    if (target !== null) out.push({ path: rel, hash: '', size: 0, mode: 0o777, kind: 'symlink', target })
  }
  for (const rel of emptyDirs) {
    const stat = await fs.promises.stat(path.join(root, rel)).catch(removed)
    if (stat) out.push({ path: rel, hash: '', size: 0, mode: stat.mode & 0o777, mtimeMs: Math.round(stat.mtimeMs), kind: 'dir' })
  }
  return { entries: out, scanned }
}

/**
 * Calls `onChange` with the path of each file or folder that changes under `root`, top-level
 * `excluded` folders left out. One watch per folder: Node's recursive watch on Linux stops
 * reporting a file once a rename has replaced it twice, and a safe write (a temp file renamed over
 * the file) replaces it every time. Returns a function that stops watching.
 */
export function watchTree(root, excluded, onChange) {
  const watchers = new Map()
  const unwatch = (rel) => {
    for (const [key, watcher] of watchers) {
      if (key === rel || key.startsWith(`${rel}/`)) {
        watcher.close()
        watchers.delete(key)
      }
    }
  }
  const watchFolder = (rel) => {
    const abs = path.join(root, rel)
    let watcher
    try {
      watcher = fs.watch(abs, (_event, name) => {
        if (!name || (!rel && excluded.has(String(name)))) return
        const child = rel ? `${rel}/${name}` : String(name)
        onChange(child)
        // A folder appears, goes or is replaced: its watches start over.
        let isFolder = false
        try {
          isFolder = fs.lstatSync(path.join(root, child)).isDirectory()
        } catch {}
        if (isFolder || watchers.has(child)) {
          unwatch(child)
          if (isFolder) watchFolder(child)
        }
      })
    } catch {
      return // removed before it could be watched
    }
    watcher.on('error', () => unwatch(rel))
    watchers.set(rel, watcher)
    let entries = []
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory() || (!rel && excluded.has(entry.name))) continue
      watchFolder(rel ? `${rel}/${entry.name}` : entry.name)
    }
  }
  watchFolder('')
  return () => unwatch('')
}
