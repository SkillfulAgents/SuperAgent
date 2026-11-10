// Runs first in the agent's Cloudflare Container. The container's disk is empty on every start, so
// AgentDurableObject (src/cf/cloudflare-agent.ts) restores /workspace through here, then
// launches the agent. Files live in R2, one object per content hash, reached at
// http://workspace.internal (routed by AgentDurableObject).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { hashFile, inPool, scan, watchTree } from './workspace-scan.mjs'

const WORKSPACE = '/workspace'
const PORT = 8090
const STORE = 'http://workspace.internal'
// Top-level folders that are rebuilt, not kept.
const EXCLUDED = new Set(['.bun-cache'])
// Changes are saved in batches, this long after the first change of a batch.
const BATCH_MS = 2_000

let agent = null
// Set once the container is told to stop: the agent's exit then waits for the last changes to be saved.
let stopping = false
let flushChanges = async () => {}
// path -> { size, mtimeMs, hash, mode } from the last scan, so unchanged files are not rehashed.
let scanned = new Map()

const end = (res, status, text) => res.writeHead(status, { 'content-type': 'text/plain' }).end(text)
const json = (res, value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
const readJson = async (req) => JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString('utf8'))

async function restore(entries) {
  await inPool(entries, async (entry) => {
    const abs = path.join(WORKSPACE, entry.path)
    const kind = entry.kind ?? 'file'
    if (kind === 'dir') {
      await fs.promises.mkdir(abs, { recursive: true, mode: entry.mode })
      return
    }
    await fs.promises.mkdir(path.dirname(abs), { recursive: true })
    if (kind === 'symlink') {
      await fs.promises.symlink(entry.target, abs)
      return
    }
    const response = await fetch(`${STORE}/blobs/${entry.hash}`)
    if (!response.ok) throw new Error(`blob ${entry.hash} for ${entry.path}: ${response.status}`)
    await fs.promises.writeFile(abs, Readable.fromWeb(response.body))
    await fs.promises.chmod(abs, entry.mode)
  })
}

// 'ok', or 'changed' when the store found the bytes no longer match the hash.
async function put(rel, hash) {
  const abs = path.join(WORKSPACE, rel)
  const { size } = await fs.promises.stat(abs)
  // Streamed, with its length: R2 stores a stream only when it knows the size up front.
  const response = await fetch(`${STORE}/blobs/${hash}`, {
    method: 'PUT',
    body: Readable.toWeb(fs.createReadStream(abs)),
    duplex: 'half',
    headers: { 'x-content-length': String(size) },
  })
  if (response.status === 409) return 'changed'
  if (!response.ok) throw new Error(`upload ${rel}: ${response.status}`)
  return 'ok'
}

const UPLOAD_TRIES = 3

// Uploads one file for each hash. A file that changed since the scan is hashed and uploaded again;
// the answer says which files got a new hash, which kept changing, and which were removed meanwhile.
async function upload(hashes) {
  const pathsByHash = new Map()
  for (const [rel, f] of scanned) pathsByHash.set(f.hash, [...(pathsByHash.get(f.hash) ?? []), rel])
  const redo = []
  await inPool(hashes, async (hash) => {
    for (const rel of pathsByHash.get(hash) ?? []) {
      const outcome = await put(rel, hash).catch((error) => (error.code === 'ENOENT' ? 'changed' : Promise.reject(error)))
      if (outcome === 'ok') return
      redo.push(rel)
    }
  })
  const result = { changed: [], skipped: [], removed: [] }
  await inPool(redo, async (rel) => {
    const abs = path.join(WORKSPACE, rel)
    for (let attempt = 0; attempt < UPLOAD_TRIES; attempt++) {
      const stat = await fs.promises.stat(abs).catch(() => null)
      if (!stat?.isFile()) {
        result.removed.push(rel)
        return
      }
      const hash = await hashFile(abs).catch(() => null)
      if (hash && (await put(rel, hash).catch(() => 'changed')) === 'ok') {
        scanned.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs, hash, mode: stat.mode & 0o777 })
        result.changed.push({ path: rel, hash, size: stat.size, mode: stat.mode & 0o777, mtimeMs: Math.round(stat.mtimeMs), kind: 'file' })
        return
      }
    }
    result.skipped.push(rel)
  })
  return result
}

const gone = (error) => (error?.code === 'ENOENT' ? null : Promise.reject(error))

// The saved form of one changed path: a file, a symlink, or every file under a folder (a folder
// moved in brings files no event names). Null when the path is gone.
async function entriesAt(rel) {
  const abs = path.join(WORKSPACE, rel)
  const stat = await fs.promises.lstat(abs).catch(gone)
  if (!stat) return null
  if (stat.isSymbolicLink()) {
    const target = await fs.promises.readlink(abs).catch(gone)
    return target === null ? null : [{ path: rel, hash: '', size: 0, mode: 0o777, kind: 'symlink', target }]
  }
  if (stat.isDirectory()) {
    const prefix = `${rel}/`
    const known = new Map([...scanned].filter(([p]) => p.startsWith(prefix)).map(([p, f]) => [p.slice(prefix.length), f]))
    const result = await scan(abs, new Set(), known)
    for (const [p, f] of result.scanned) scanned.set(prefix + p, f)
    return result.entries.map((entry) => ({ ...entry, path: prefix + entry.path }))
  }
  if (!stat.isFile()) return []
  const known = scanned.get(rel)
  const hash = known && known.size === stat.size && known.mtimeMs === stat.mtimeMs ? known.hash : await hashFile(abs).catch(gone)
  if (!hash) return null
  scanned.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs, hash, mode: stat.mode & 0o777 })
  return [{ path: rel, hash, size: stat.size, mode: stat.mode & 0o777, mtimeMs: Math.round(stat.mtimeMs), kind: 'file' }]
}

const sendChanges = (entries, removed) =>
  fetch(`${STORE}/changes`, { method: 'POST', body: JSON.stringify({ entries, removed }) })

// Saves one batch of changed paths. Bytes go up only for hashes the store says it lacks.
async function saveBatch(paths, again) {
  let entries = []
  const removed = []
  for (const rel of paths) {
    const found = await entriesAt(rel)
    if (found === null) {
      removed.push(rel)
      for (const p of scanned.keys()) if (p === rel || p.startsWith(`${rel}/`)) scanned.delete(p)
    } else entries.push(...found)
  }
  if (entries.length === 0 && removed.length === 0) return
  let response = await sendChanges(entries, removed)
  if (response.status === 409 && response.headers.get('content-type')?.includes('json')) {
    const { missing } = await response.json()
    const changed = new Set()
    await inPool(missing, async (hash) => {
      for (const entry of entries.filter((e) => e.hash === hash)) {
        const outcome = await put(entry.path, hash).catch((error) => (error.code === 'ENOENT' ? 'changed' : Promise.reject(error)))
        if (outcome === 'changed') changed.add(entry.path)
      }
    })
    // A file that changed while it was uploaded is saved with the next batch.
    for (const rel of changed) again(rel)
    entries = entries.filter((entry) => !changed.has(entry.path))
    response = await sendChanges(entries, removed)
  }
  if (!response.ok) throw new Error(`saving changes: ${response.status} ${await response.text().catch(() => '')}`)
}

// Saves each change a moment after it happens, so a crash loses seconds of work. Batches go one at a time.
// Returns a flush that saves what is still waiting at once, for a stop.
function saveChanges() {
  const changed = new Set()
  let timer = null
  let saving = Promise.resolve()
  const mark = (rel) => {
    changed.add(rel)
    timer ??= setTimeout(() => {
      timer = null
      const batch = [...changed]
      changed.clear()
      saving = saving.then(() => saveBatch(batch, mark)).catch((error) => {
        console.error('[snapshot-server] saving changes failed; trying again:', error)
        for (const rel of batch) mark(rel)
      })
    }, BATCH_MS)
  }
  watchTree(WORKSPACE, EXCLUDED, mark)
  return async () => {
    clearTimeout(timer)
    timer = null
    const batch = [...changed]
    changed.clear()
    await saving
    if (batch.length > 0) await saveBatch(batch, () => {})
  }
}

http.createServer(async (req, res) => {
  const route = `${req.method} ${new URL(req.url, 'http://local').pathname}`
  try {
    if (route === 'GET /state') return json(res, { launched: agent !== null })

    if (route === 'POST /restore') {
      if (agent) return end(res, 409, 'the agent is already running')
      const { files } = await readJson(req)
      await restore(files)
      return end(res, 200, `restored ${files.length} files`)
    }

    // Before launch, /workspace is not (yet) the agent's: saving it could replace a good one.
    if (route === 'POST /scan') {
      if (!agent) return end(res, 409, 'the agent has not been launched')
      const result = await scan(WORKSPACE, EXCLUDED, scanned)
      scanned = result.scanned
      return json(res, { files: result.entries })
    }

    if (route === 'POST /upload') {
      if (!agent) return end(res, 409, 'the agent has not been launched')
      const { hashes } = await readJson(req)
      return json(res, await upload(hashes))
    }

    if (route === 'POST /launch') {
      if (!agent) {
        agent = spawn('gamut-start', [], { cwd: '/app', stdio: 'inherit' })
        agent.on('exit', (code) => {
          console.error(`[snapshot-server] agent exited with ${code}`)
          if (!stopping) process.exit(code ?? 1)
        })
        flushChanges = saveChanges()
      }
      return end(res, 200, 'launched')
    }

    end(res, 404, 'not found')
  } catch (error) {
    end(res, 500, String(error))
  }
}).listen(PORT)

// The container's first request to the store is slow (~1 s); make it now, while the
// AgentDurableObject still waits for this port, so the restore does not pay for it.
fetch(`${STORE}/warm`).then((response) => response.body?.cancel()).catch(() => {})

// As PID 1, Node ignores SIGTERM unless it handles it, and the container would never stop.
// Cloudflare also sends it on its own, when it rolls the container onto a new image: the changes
// of the last seconds are saved before the container exits.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (!agent || stopping) process.exit(0)
    stopping = true
    agent.kill(signal)
    setTimeout(() => process.exit(0), 10_000).unref()
    agent.once('exit', () => {
      flushChanges()
        .catch((error) => console.error('[snapshot-server] saving the last changes failed:', error))
        .finally(() => process.exit(0))
    })
  })
}
