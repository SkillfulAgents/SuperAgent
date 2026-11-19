// What the cf-workspace-server serves in the agent's Cloudflare Container: it restores and saves
// /workspace, launches the agent, and adds to the end of a file for the agent's actor. The
// container's disk is empty on every start, so AgentDurableObject (src/cf/objects/cloudflare-agent.ts)
// restores /workspace through here, then launches the agent. Files live in R2, one object per
// content hash, reached at the store (http://workspace.internal, routed by AgentDurableObject).
// cf-workspace-server.mjs runs this in the container; nothing here starts by itself, so a test can run it
// on a folder and a store of its own.
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { hashFile, inPool, scan, seen, unchanged, watchTree } from './workspace-scan.mjs'

// Top-level folders that are rebuilt, not kept.
const EXCLUDED = new Set(['.bun-cache'])
// Changes are saved in batches, this long after the first change of a batch.
const BATCH_MS = 2_000
// A batch that failed is tried again after a wait that doubles up to this.
const RETRY_MAX_MS = 60_000
// A folder that cannot be watched is scanned this often instead.
const POLL_MS = 30_000
// On a stop: how long the agent gets to exit before it is killed, and how long the last save may take.
const AGENT_EXIT_MS = 10_000
const LAST_SAVE_MS = 5 * 60_000

const end = (res, status, text) => res.writeHead(status, { 'content-type': 'text/plain' }).end(text)
const json = (res, value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
const readJson = async (req) => JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString('utf8'))
const gone = (error) => (error?.code === 'ENOENT' ? null : Promise.reject(error))
const UPLOAD_TRIES = 3

/**
 * `workspace` is the folder restored and saved, `store` the origin its bytes and file list go to.
 * `launch` starts the agent and returns its process, and `exit` ends this one. A test passes its
 * own `fetch` as the store and a short `batchMs`.
 */
export function createWorkspaceService({ workspace: WORKSPACE, store: STORE, launch, exit, fetch = globalThis.fetch, batchMs = BATCH_MS }) {
  let agent = null
  // Set once the container is told to stop: the agent's exit then waits for the last changes to be saved.
  let stopping = false
  let flushChanges = async () => {}
  let stopWatching = () => {}
  // path -> { size, mtimeMs, hash, mode } from the last scan, so unchanged files are not rehashed.
  let scanned = new Map()

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
        // A restore tried again finds the link it made the first time.
        await fs.promises.rm(abs, { force: true })
        await fs.promises.symlink(entry.target, abs)
        return
      }
      const response = await fetch(`${STORE}/blobs/${entry.hash}`)
      if (!response.ok) throw new Error(`blob ${entry.hash} for ${entry.path}: ${response.status}`)
      await fs.promises.writeFile(abs, Readable.fromWeb(response.body))
      await fs.promises.chmod(abs, entry.mode)
      // The time it was last changed, not the time of this restore: tools and the file list compare it.
      if (entry.mtimeMs) await fs.promises.utimes(abs, new Date(), new Date(entry.mtimeMs))
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
          scanned.set(rel, seen(stat, hash))
          result.changed.push({ path: rel, hash, size: stat.size, mode: stat.mode & 0o777, mtimeMs: Math.round(stat.mtimeMs), kind: 'file' })
          return
        }
      }
      result.skipped.push(rel)
    })
    return result
  }

  // The saved form of one changed path: a file, a symlink, or what changed under a folder (a folder
  // moved in brings files no event names, and a folder nobody watches is looked through whole).
  // `removed` are files under a folder that the last look saw and this one did not. Null when the path is gone.
  async function entriesAt(rel) {
    const abs = path.join(WORKSPACE, rel)
    const stat = await fs.promises.lstat(abs).catch(gone)
    if (!stat) return null
    if (stat.isSymbolicLink()) {
      const target = await fs.promises.readlink(abs).catch(gone)
      return target === null ? null : { entries: [{ path: rel, hash: '', size: 0, mode: 0o777, kind: 'symlink', target }], removed: [] }
    }
    if (stat.isDirectory()) {
      // A file the last look saw here is gone; the store drops it when it takes the folder's entries.
      scanned.delete(rel)
      const prefix = `${rel}/`
      const known = new Map([...scanned].filter(([p]) => p.startsWith(prefix)).map(([p, f]) => [p.slice(prefix.length), f]))
      const result = await scan(abs, new Set(), known)
      for (const [p, f] of result.scanned) scanned.set(prefix + p, f)
      const removed = [...known.keys()].filter((p) => !result.scanned.has(p)).map((p) => prefix + p)
      for (const p of removed) scanned.delete(p)
      // A file as the last look saw it is already saved.
      const same = (entry) => entry.kind === 'file' && known.get(entry.path)?.hash === entry.hash && known.get(entry.path)?.mode === entry.mode
      return { entries: result.entries.filter((entry) => !same(entry)).map((entry) => ({ ...entry, path: prefix + entry.path })), removed }
    }
    if (!stat.isFile()) return { entries: [], removed: [] }
    const known = scanned.get(rel)
    const hash = unchanged(known, stat) ? known.hash : await hashFile(abs).catch(gone)
    if (!hash) return null
    scanned.set(rel, seen(stat, hash))
    return { entries: [{ path: rel, hash, size: stat.size, mode: stat.mode & 0o777, mtimeMs: Math.round(stat.mtimeMs), kind: 'file' }], removed: [] }
  }

  const sendChanges = (entries, removed, uploaded = []) =>
    fetch(`${STORE}/changes`, { method: 'POST', body: JSON.stringify({ entries, removed, uploaded }) })

  // Saves one batch of changed paths. Bytes go up only for hashes the store asks for, which it is then told were uploaded.
  async function saveBatch(paths, again) {
    let entries = []
    const removed = []
    for (const rel of paths) {
      const found = await entriesAt(rel)
      if (found === null) {
        removed.push(rel)
        for (const p of scanned.keys()) if (p === rel || p.startsWith(`${rel}/`)) scanned.delete(p)
      } else {
        entries.push(...found.entries)
        removed.push(...found.removed)
      }
    }
    if (entries.length === 0 && removed.length === 0) return
    let response = await sendChanges(entries, removed)
    if (response.status === 409 && response.headers.get('content-type')?.includes('json')) {
      const { missing } = await response.json()
      const changed = new Set()
      const uploaded = []
      const pathsByHash = Map.groupBy(entries, (entry) => entry.hash)
      await inPool(missing, async (hash) => {
        for (const entry of pathsByHash.get(hash) ?? []) {
          const outcome = await put(entry.path, hash).catch((error) => (error.code === 'ENOENT' ? 'changed' : Promise.reject(error)))
          if (outcome === 'changed') changed.add(entry.path)
          else return uploaded.push(hash)
        }
      })
      // A file that changed while it was uploaded is saved with the next batch.
      for (const rel of changed) again(rel)
      entries = entries.filter((entry) => !changed.has(entry.path))
      response = await sendChanges(entries, removed, uploaded)
    }
    if (!response.ok) throw new Error(`saving changes: ${response.status} ${await response.text().catch(() => '')}`)
  }

  // Saves each change a moment after it happens, so a crash loses seconds of work. Batches go one at a time.
  // Returns a flush that saves what is still waiting at once, for a stop.
  function saveChanges() {
    const changed = new Set()
    let timer = null
    let saving = Promise.resolve()
    let wait = batchMs
    const mark = (rel) => {
      changed.add(rel)
      timer ??= setTimeout(() => {
        timer = null
        const batch = [...changed]
        changed.clear()
        saving = saving.then(() => saveBatch(batch, mark)).then(() => {
          wait = batchMs
        }, (error) => {
          wait = Math.min(wait * 2, RETRY_MAX_MS)
          console.error(`[cf-workspace-server] saving changes failed; trying again in ${wait / 1000} s:`, error)
          for (const rel of batch) mark(rel)
        })
      }, wait)
    }
    // Past the system's watch limit a folder gets no watch, and nothing would report its changes.
    const unwatched = new Set()
    const unwatch = watchTree(WORKSPACE, EXCLUDED, mark, (rel, error) => {
      if (unwatched.size === 0) console.error(`[cf-workspace-server] cannot watch /${rel} (${error?.code ?? error}); folders like it are scanned every ${POLL_MS / 1000} s instead`)
      unwatched.add(rel)
    })
    const poll = setInterval(() => {
      for (const rel of unwatched) {
        if (!rel || !fs.existsSync(path.join(WORKSPACE, rel))) unwatched.delete(rel)
        else mark(rel)
      }
    }, POLL_MS)
    poll.unref()
    stopWatching = () => {
      unwatch()
      clearInterval(poll)
      clearTimeout(timer)
    }
    return async () => {
      clearTimeout(timer)
      timer = null
      const batch = [...changed]
      changed.clear()
      await saving
      if (batch.length > 0) await saveBatch(batch, () => {})
    }
  }

  /** The absolute path of a relative path inside the workspace; null for anything else. */
  function insideWorkspace(rel) {
    if (!rel || rel.includes('\0') || rel.split('/').some((part) => part === '' || part === '.' || part === '..')) return null
    return path.join(WORKSPACE, rel)
  }

  /** The server's requests: /state, /restore, /scan, /upload, /launch and /append. */
  async function handle(req, res) {
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
          agent = launch()
          agent.on('exit', (code) => {
            console.error(`[cf-workspace-server] agent exited with ${code}`)
            if (stopping) return
            // It ended by itself: the changes of its last seconds are saved before the container goes with them.
            stopping = true
            setTimeout(() => exit(code ?? 1), LAST_SAVE_MS).unref()
            flushChanges()
              .catch((error) => console.error('[cf-workspace-server] saving the last changes failed:', error))
              .finally(() => exit(code ?? 1))
          })
          flushChanges = saveChanges()
        }
        return end(res, 200, 'launched')
      }

      // One write at the end of the file, so the bytes land whole next to what the agent's own
      // process appends to the same file (a session's transcript). A caller that read the file and
      // wrote it back would lose the lines written in between.
      if (route === 'POST /append') {
        const abs = insideWorkspace(new URL(req.url, 'http://local').searchParams.get('path'))
        if (!abs) return end(res, 400, 'not a path inside the workspace')
        const bytes = Buffer.concat(await Array.fromAsync(req))
        await fs.promises.mkdir(path.dirname(abs), { recursive: true })
        try {
          await fs.promises.appendFile(abs, bytes)
        } catch (error) {
          if (error?.code === 'EISDIR') return end(res, 409, 'not a file')
          throw error
        }
        return end(res, 200, 'appended')
      }

      end(res, 404, 'not found')
    } catch (error) {
      end(res, 500, String(error))
    }
  }

  // The container's first request to the store is slow (~1 s); made while AgentDurableObject still
  // waits for the server's port, the restore does not pay for it.
  function warm() {
    fetch(`${STORE}/warm`).then((response) => response.body?.cancel()).catch(() => {})
  }

  // Cloudflare sends SIGTERM when the agent's object stops the container: the agent stops, then the
  // changes of the last seconds are saved before this process exits.
  function stop(signal) {
    if (!agent) return exit(0)
    // A second signal does not cut the last save short.
    if (stopping) return
    stopping = true
    const saveAndExit = () => {
      // The save gets the time a large file needs, but a store that never answers does not keep the container up.
      setTimeout(() => exit(1), LAST_SAVE_MS).unref()
      flushChanges()
        .catch((error) => console.error('[cf-workspace-server] saving the last changes failed:', error))
        .finally(() => exit(0))
    }
    if (agent.exitCode !== null || agent.signalCode !== null) return saveAndExit()
    agent.once('exit', saveAndExit)
    agent.kill(signal)
    setTimeout(() => agent.kill('SIGKILL'), AGENT_EXIT_MS).unref()
  }

  /** Stops watching the workspace, without a last save: for a test that is done with it. */
  const close = () => stopWatching()

  return { handle, warm, stop, close }
}
