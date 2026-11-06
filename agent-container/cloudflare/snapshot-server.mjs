// Runs first in the agent's Cloudflare Container. The container's disk is empty on every start, so
// CloudflareAgentActor (src/cf/cloudflare-agent-actor.ts) restores /workspace through here, then
// launches the agent. Files live in R2, one object per content hash, reached at
// http://workspace.internal (routed by CloudflareAgentActor).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { hashFile, inPool, scan } from './workspace-scan.mjs'

const WORKSPACE = '/workspace'
const PORT = 8090
const STORE = 'http://workspace.internal'
// Top-level folders that are rebuilt, not kept.
const EXCLUDED = new Set(['.bun-cache'])
// Ask for a save once the workspace has been quiet this long, or has stayed busy this long.
const QUIET_MS = 10_000
const MAX_DIRTY_MS = 5 * 60_000

let agent = null
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

// Saves follow the agent's writes: a turn ends, writes stop, and the workspace is saved.
function watchForSaves() {
  let quiet = null
  let dirtySince = 0
  const requestSave = () => {
    clearTimeout(quiet)
    quiet = null
    dirtySince = 0
    fetch(`${STORE}/save`, { method: 'POST' }).catch((error) => console.error('[snapshot-server] save request failed:', error))
  }
  fs.watch(WORKSPACE, { recursive: true }, (_event, name) => {
    if (name && EXCLUDED.has(String(name).split('/')[0])) return
    dirtySince ||= Date.now()
    clearTimeout(quiet)
    quiet = Date.now() - dirtySince >= MAX_DIRTY_MS ? setTimeout(requestSave, 0) : setTimeout(requestSave, QUIET_MS)
  })
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
          process.exit(code ?? 1)
        })
        watchForSaves()
      }
      return end(res, 200, 'launched')
    }

    end(res, 404, 'not found')
  } catch (error) {
    end(res, 500, String(error))
  }
}).listen(PORT)

// The container's first request to the store is slow (~1 s); make it now, while the
// CloudflareAgentActor still waits for this port, so the restore does not pay for it.
fetch(`${STORE}/warm`).then((response) => response.body?.cancel()).catch(() => {})

// As PID 1, Node ignores SIGTERM unless it handles it, and the container would never stop.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (!agent) process.exit(0)
    agent.kill(signal)
    setTimeout(() => process.exit(0), 10_000).unref()
  })
}
