/**
 * One agent's Durable Object. It owns the agent's Cloudflare Container, which SuperAgent's
 * cloudflare-container runner starts and stops through the contract in cloudflare-container-control.ts.
 *
 * The container's disk is empty on every start, so the workspace lives here between runs: each
 * file's bytes in R2 under its content hash, and the list of files (path, hash, size, mode) in this
 * object's SQLite. It is restored before the agent launches, and saved when the agent's writes go
 * quiet, before the container stops, and before it sleeps. While the agent sleeps, its files are
 * read and written here (the stored* methods).
 *
 * The agent's actor runs here too: its ops come from the rest of the org over this object's stub
 * (`remoteActor`), and this object boots SuperAgent to serve them. Calls the actor makes back to
 * the host stay in this isolate, which shares the org's database and AppState. SuperAgent's idle
 * alarm for the agent is kept in this object's alarm.
 */
import { Container, type StopParams } from '@cloudflare/containers'
import type { DurableObjectState } from 'cloudflare:workers'
import { ASLEEP_HEADER, type StoredEntry } from './cloudflare-container-control'
import { runAsAgentObject } from './agent-objects'
import type { Env } from './index'

// The agent server's port: the image's PORT, SuperAgent's CONTAINER_INTERNAL_PORT. Not imported:
// this module loads when the Worker starts, and the container client pulls in too much for that.
const CONTAINER_INTERNAL_PORT = 3000
// agent-container/cloudflare/snapshot-server.mjs: restores and saves /workspace, then launches the agent.
const SNAPSHOT_PORT = 8090
const SNAPSHOT_SERVER = ['node', '/opt/gamut/cloudflare/snapshot-server.mjs']
// The library polls a starting container every 300 ms; a boot waits twice.
const BOOT_POLL_MS = 50
// R2 deletes at most 1,000 keys per call.
const DELETE_BATCH = 1000
// Mode of a file first written while the agent sleeps.
const NEW_FILE_MODE = 0o644
const BLOB = /^\/blobs\/([0-9a-f]{64})$/
// remoteActor's default origin: requests for this host are the actor's ops.
const ACTOR_HOST = 'actor'
// The scheduled method that rings SuperAgent's idle alarm for this agent.
const IDLE_ALARM = 'ringIdleAlarm'

// A type, not an interface: SQL row types must be assignable to Record<string, SqlStorageValue>.
type WorkspaceFile = {
  path: string
  /** Empty for a symlink or a folder. */
  hash: string
  size: number
  mode: number
  mtimeMs?: number
  /** A 'dir' row is a folder with nothing in it. */
  kind?: 'file' | 'symlink' | 'dir'
  /** A symlink's target. */
  target?: string | null
}

type UploadResult = { changed: WorkspaceFile[]; skipped: string[]; removed: string[] }

const hex = (digest: ArrayBuffer) => [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Where one agent's file bytes are kept: one object per content hash. */
export function workspaceBlobKey(objectId: string, hash: string): string {
  return `agents/${objectId}/blobs/${hash}`
}

/**
 * The container's requests to http://workspace.internal. They run in the Worker (the library's
 * ContainerProxy is a Worker entrypoint), so file bytes go between the container and R2 there,
 * never through this object: it keeps only the file list, so a large save neither fills its
 * memory nor holds its one thread.
 */
export async function serveWorkspaceRequest(request: Request, env: Env, objectId: string): Promise<Response> {
  const { pathname } = new URL(request.url)
  if (pathname === '/warm' && request.method === 'GET') return new Response(null, { status: 204 })
  const hash = BLOB.exec(pathname)?.[1]
  if (hash && request.method === 'GET') {
    const object = await env.WORKSPACES.get(workspaceBlobKey(objectId, hash))
    return object ? new Response(object.body) : new Response(null, { status: 404 })
  }
  const agent = () => env.AGENT_ACTOR.get(env.AGENT_ACTOR.idFromString(objectId))
  if (hash && request.method === 'PUT') {
    const length = Number(request.headers.get('x-content-length'))
    if (!request.body || !Number.isInteger(length)) return new Response('x-content-length required', { status: 400 })
    // Recorded before the bytes land, so the object can drop them if no file ends up using them.
    await agent().markBlobPending(hash)
    try {
      // R2 keeps the bytes only if they hash to `hash`: the file can change between the
      // container's scan and this upload. A refused upload leaves any stored copy as it was.
      await env.WORKSPACES.put(workspaceBlobKey(objectId, hash), request.body.pipeThrough(new FixedLengthStream(length)), { sha256: hash })
      return new Response(null, { status: 204 })
    } catch (error) {
      console.warn(`[workspace] refused upload of ${hash.slice(0, 12)} for ${objectId.slice(0, 12)}:`, error)
      return new Response('the file changed since it was scanned', { status: 409 })
    }
  }
  return agent().workspaceRequest(request)
}

/** The container's calls to the host (proxy, host tools, bootstrap): the API, in the Worker. */
async function serveHostRequest(request: Request, env: Env): Promise<Response> {
  const app = await import('./boot')
  await app.boot(env)
  return app.serveContainerRequest(request, env)
}

export class CloudflareAgentActor extends Container<Env> {
  defaultPort = CONTAINER_INTERNAL_PORT
  entrypoint = SNAPSHOT_SERVER
  // The library stops an idle container after this long; the agent's own idle alarm is SuperAgent's.
  sleepAfter = '30m'
  enableInternet = true

  private starting: Promise<void> | undefined
  // From the moment a stop begins until the container has exited: a request reaching the exiting
  // container would get errors, not an asleep answer.
  private stopping: Promise<void> | undefined
  // Cached once the container reports a launched agent; cleared when it stops.
  private launched = false
  private saving: Promise<boolean> | undefined
  // A save asked for while one runs: the running one may have scanned before the newer writes.
  private saveQueued = false
  // Restoring on wake and changing the saved workspace take turns, so a change can't land after a restore read the list.
  private storeLock: Promise<unknown> = Promise.resolve()
  // The actor's cached container status starts as stopped in a new object, but the container outlives the object.
  private statusSynced: Promise<void> | undefined

  static {
    this.outboundByHost = {
      'host.internal': (request: Request, env: Env) => serveHostRequest(request, env),
      'workspace.internal': (request: Request, env: Env, ctx: { containerId: string }) => serveWorkspaceRequest(request, env, ctx.containerId),
    }
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const sql = ctx.storage.sql
    sql.exec("CREATE TABLE IF NOT EXISTS workspace_file (path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, mode INTEGER NOT NULL, mtime INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'file', target TEXT)")
    sql.exec('CREATE TABLE IF NOT EXISTS workspace_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)')
    // File bytes stored in R2 but not yet in the file list: a save or write that fails leaves them behind.
    sql.exec('CREATE TABLE IF NOT EXISTS workspace_pending (hash TEXT PRIMARY KEY)')
  }

  // Only startAgent may start the container: anything else reaching a stopped one would start it
  // with no env, no restore and no agent. Until the agent is up it reads as asleep.
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === ACTOR_HOST) return this.serveActor(request)
    if (!(await this.agentRunning())) return new Response(null, { status: 503, headers: { [ASLEEP_HEADER]: '1' } })
    return super.fetch(request)
  }

  /** Keeps SuperAgent's idle alarm for this agent in this object's alarm, so it goes off after the isolate is gone. */
  setIdleAlarm(at: number): void {
    this.deleteSchedules(IDLE_ALARM)
    this.schedule(new Date(at), IDLE_ALARM).catch((error: unknown) => {
      console.error(`[CloudflareAgentActor ${this.agentName()}] arming the idle alarm failed:`, error)
    })
  }

  clearIdleAlarm(): void {
    this.deleteSchedules(IDLE_ALARM)
  }

  /** SuperAgent's idle alarm for this agent went off (setIdleAlarm). */
  async ringIdleAlarm(): Promise<void> {
    const slug = this.agentName()
    await runAsAgentObject(slug, this, async () => {
      const app = await import('./boot')
      await app.boot(this.env)
      await app.ringIdleAlarm(slug)
    })
  }

  private serveActor(request: Request): Promise<Response> {
    const slug = this.agentName()
    return runAsAgentObject(slug, this, async () => {
      const app = await import('./boot')
      await app.boot(this.env)
      await (this.statusSynced ??= app.syncAgentStatus(slug).catch((error: unknown) => {
        this.statusSynced = undefined
        console.error(`[CloudflareAgentActor ${slug}] syncing the container status failed:`, error)
      }))
      return app.serveActorRequest(request)
    })
  }

  override onStop(params: StopParams): void {
    this.launched = false
    console.log(`[CloudflareAgentActor ${this.agentName()}] container exited (code ${params.exitCode}, ${params.reason})`)
  }

  startAgent(envVars: Record<string, string>): Promise<void> {
    this.starting ??= this.bootAgent(envVars).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async bootAgent(envVars: Record<string, string>): Promise<void> {
    // A start that arrives during a stop runs after it, on a fresh container.
    if (this.stopping) await this.stopping
    if (await this.containerUp()) {
      if (await this.agentLaunched()) return
      // Running without a launched agent: it was not started here, so it has neither the env nor the workspace.
      await this.destroy()
    }
    await this.startAndWaitForPorts({ ports: SNAPSHOT_PORT, startOptions: { envVars }, cancellationOptions: { waitInterval: BOOT_POLL_MS } })
    await this.withStore(() => this.restoreWorkspace())
    await this.containerFetch(new Request('http://container/launch', { method: 'POST' }), SNAPSHOT_PORT)
    await this.waitForPort({ portToCheck: CONTAINER_INTERNAL_PORT, waitInterval: BOOT_POLL_MS })
    this.launched = true
    console.log(`[CloudflareAgentActor ${this.agentName()}] agent launched`)
  }

  stopAgent(): Promise<void> {
    this.stopping ??= this.shutDown().finally(() => {
      this.stopping = undefined
    })
    return this.stopping
  }

  private async shutDown(): Promise<void> {
    // The container's disk is the only copy of changes since the last save: it keeps running until one works.
    if (!(await this.saveWorkspace())) throw new Error(`Saving the workspace of agent ${this.agentName()} failed; the container keeps running`)
    this.launched = false
    await this.stop()
    // The exiting container still answers /state as launched, so wait until it is gone.
    for (let i = 0; i < 60 && (await this.containerUp()); i++) await new Promise((resolve) => setTimeout(resolve, 500))
  }

  /** What the app sees as running: a container that is up and has launched the agent. A half-started or stopping one reads as stopped. */
  async agentRunning(): Promise<boolean> {
    if (this.stopping) return false
    return this.agentUp()
  }

  // A stop that fails leaves the container running; the library renews the timeout, so it is tried again then.
  override async onActivityExpired(): Promise<void> {
    await this.stopAgent().catch((error: unknown) => console.error(`[CloudflareAgentActor ${this.agentName()}] idle stop failed:`, error))
  }

  /** Records bytes the Worker is about to store for this agent (serveWorkspaceRequest). */
  markBlobPending(hash: string): void {
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO workspace_pending (hash) VALUES (?)', hash)
  }

  /** The container's save requests; its file bytes go to R2 in the Worker. */
  async workspaceRequest(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/save' && request.method === 'POST') {
      void this.saveWorkspace()
      return new Response(null, { status: 202 })
    }
    return new Response(null, { status: 404 })
  }

  /** False when the save failed: the saved workspace is older than the container's. */
  saveWorkspace(): Promise<boolean> {
    if (this.saving) {
      this.saveQueued = true
      return this.saving
    }
    this.saving = (async () => {
      let saved: boolean
      do {
        this.saveQueued = false
        saved = await this.writeWorkspace()
      } while (this.saveQueued)
      return saved
    })().finally(() => {
      this.saving = undefined
    })
    return this.saving
  }

  async storedEntry(rel: string): Promise<StoredEntry | StoredEntry[] | null> {
    const sql = this.ctx.storage.sql
    // Symlinks are restored on wake but not shown while asleep.
    type Row = { path: string; size: number; mtime: number; kind: string }
    const file = sql.exec<Row>("SELECT path, size, mtime, kind FROM workspace_file WHERE path = ? AND kind != 'symlink'", rel).toArray()[0]
    if (file?.kind === 'file') return fileEntry(file)
    const prefix = rel ? `${rel}/` : ''
    const rows = sql.exec<Row>("SELECT path, size, mtime, kind FROM workspace_file WHERE substr(path, 1, ?) = ? AND kind != 'symlink'", prefix.length, prefix).toArray()
    if (rows.length === 0 && rel && !file) return null
    const children = new Map<string, StoredEntry>()
    for (const row of rows) {
      const rest = row.path.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) children.set(row.path, row.kind === 'dir' ? { name: rest, path: row.path, type: 'directory' } : fileEntry(row))
      else children.set(prefix + rest.slice(0, slash), { name: rest.slice(0, slash), path: prefix + rest.slice(0, slash), type: 'directory' })
    }
    return [...children.values()]
  }

  async storedRead(rel: string): Promise<Uint8Array | null> {
    const row = this.ctx.storage.sql.exec<{ hash: string }>("SELECT hash FROM workspace_file WHERE path = ? AND kind = 'file'", rel).toArray()[0]
    if (!row) return null
    const object = await this.env.WORKSPACES.get(this.blobKey(row.hash))
    return object ? new Uint8Array(await object.arrayBuffer()) : null
  }

  /** False when the agent is running: the write has to go to its container. */
  storedWrite(rel: string, bytes: Uint8Array): Promise<boolean> {
    return this.storeChange(async () => {
      const hash = hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
      const sql = this.ctx.storage.sql
      sql.exec('INSERT OR IGNORE INTO workspace_pending (hash) VALUES (?)', hash)
      await this.env.WORKSPACES.put(this.blobKey(hash), bytes)
      const previous = sql.exec<{ hash: string; mode: number }>('SELECT hash, mode FROM workspace_file WHERE path = ?', rel).toArray()[0]
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          "INSERT INTO workspace_file (path, hash, size, mode, mtime, kind, target) VALUES (?, ?, ?, ?, ?, 'file', NULL) ON CONFLICT (path) DO UPDATE SET hash = excluded.hash, size = excluded.size, mtime = excluded.mtime, kind = 'file', target = NULL",
          rel, hash, bytes.byteLength, previous?.mode ?? NEW_FILE_MODE, Date.now(),
        )
        this.bumpVersion()
      })
      if (previous?.hash && previous.hash !== hash) await this.dropUnreferenced([previous.hash])
      await this.settlePending()
    })
  }

  /** Removes a file, or a folder with everything under it. False when the agent is running. */
  storedRemove(rel: string): Promise<boolean> {
    return this.storeChange(async () => {
      const sql = this.ctx.storage.sql
      const match = 'path = ? OR substr(path, 1, ?) = ?'
      const hashes = sql.exec<{ hash: string }>(`SELECT DISTINCT hash FROM workspace_file WHERE ${match}`, rel, rel.length + 1, `${rel}/`).toArray().map((row) => row.hash)
      if (hashes.length === 0) return
      this.ctx.storage.transactionSync(() => {
        sql.exec(`DELETE FROM workspace_file WHERE ${match}`, rel, rel.length + 1, `${rel}/`)
        this.bumpVersion()
      })
      await this.dropUnreferenced(hashes)
    })
  }

  /** Deletes the agent's saved workspace, its files in R2 and its file list, after the agent is deleted. */
  purgeWorkspace(): Promise<void> {
    return this.withStore(async () => {
      if (await this.containerUp()) await this.destroy()
      this.launched = false
      const prefix = `agents/${this.ctx.id.toString()}/`
      let cursor: string | undefined
      do {
        const page = await this.env.WORKSPACES.list({ prefix, cursor })
        if (page.objects.length > 0) await this.env.WORKSPACES.delete(page.objects.map((object) => object.key))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      const sql = this.ctx.storage.sql
      this.ctx.storage.transactionSync(() => {
        for (const table of ['workspace_file', 'workspace_meta', 'workspace_pending']) sql.exec(`DELETE FROM ${table}`)
      })
    })
  }

  private async agentUp(): Promise<boolean> {
    if (!(await this.containerUp())) return false
    if (await this.agentLaunched()) return true
    // Up with no agent and not starting: nothing will launch it, and it holds an instance slot.
    if (!this.starting) await this.destroy()
    return false
  }

  private async containerUp(): Promise<boolean> {
    const { status } = await this.getState()
    return status === 'running' || status === 'healthy'
  }

  private async agentLaunched(): Promise<boolean> {
    if (this.launched) return true
    try {
      const response = await this.containerFetch(new Request('http://container/state'), SNAPSHOT_PORT)
      this.launched = response.ok && ((await response.json()) as { launched: boolean }).launched
    } catch {
      this.launched = false
    }
    return this.launched
  }

  /** True when saved, or when there is nothing to save: no agent ran on this container's workspace. */
  private async writeWorkspace(): Promise<boolean> {
    // Only a workspace the agent ran on (restored, then launched) may replace the saved one.
    if (!(await this.agentUp())) return true
    const sql = this.ctx.storage.sql
    try {
      // Bytes a failed save uploaded and no file uses.
      await this.settlePending()
      const scan = await this.containerFetch(new Request('http://container/scan', { method: 'POST' }), SNAPSHOT_PORT)
      if (!scan.ok) throw new Error(`scan returned ${scan.status}: ${await scan.text()}`)
      let { files } = (await scan.json()) as { files: WorkspaceFile[] }
      const stored = new Set(this.storedHashes())
      const kept = new Set(files.filter((file) => (file.kind ?? 'file') === 'file').map((file) => file.hash))
      const missing = [...kept].filter((hash) => !stored.has(hash))
      let uploaded: UploadResult = { changed: [], skipped: [], removed: [] }
      if (missing.length > 0) {
        const upload = await this.containerFetch(new Request('http://container/upload', { method: 'POST', body: JSON.stringify({ hashes: missing }) }), SNAPSHOT_PORT)
        if (!upload.ok) throw new Error(`upload returned ${upload.status}: ${await upload.text()}`)
        uploaded = (await upload.json()) as UploadResult
        files = this.applyUpload(files, uploaded)
      }
      const version = this.workspaceVersion() + 1
      this.ctx.storage.transactionSync(() => {
        sql.exec('DELETE FROM workspace_file')
        for (const file of files) {
          sql.exec(
            'INSERT INTO workspace_file (path, hash, size, mode, mtime, kind, target) VALUES (?, ?, ?, ?, ?, ?, ?)',
            file.path, file.hash, file.size, file.mode, Math.round(file.mtimeMs ?? 0), file.kind ?? 'file', file.target ?? null,
          )
        }
        sql.exec('INSERT INTO workspace_meta (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version', version)
      })
      const dropped = await this.dropUnreferenced([...stored])
      await this.settlePending()
      console.log(`[CloudflareAgentActor ${this.agentName()}] saved workspace version ${version}: ${files.length} entries, ${missing.length} uploaded, ${dropped} removed`)
      return true
    } catch (error) {
      console.error(`[CloudflareAgentActor ${this.agentName()}] workspace save failed; keeping the previous one:`, error)
      return false
    }
  }

  private async restoreWorkspace(): Promise<void> {
    const files = this.ctx.storage.sql.exec<WorkspaceFile>('SELECT path, hash, size, mode, kind, target FROM workspace_file').toArray()
    if (files.length === 0) return
    const response = await this.containerFetch(new Request('http://container/restore', { method: 'POST', body: JSON.stringify({ files }) }), SNAPSHOT_PORT)
    if (!response.ok) throw new Error(`Workspace restore failed: ${await response.text()}`)
  }

  private async storeChange(change: () => Promise<void>): Promise<boolean> {
    for (;;) {
      if (this.stopping) await this.stopping
      if (this.starting) await this.starting.catch(() => {})
      const outcome = await this.withStore(async () => {
        if (this.starting || this.stopping) return 'retry'
        if (await this.agentRunning()) return 'running'
        await change()
        return 'done'
      })
      if (outcome !== 'retry') return outcome === 'done'
    }
  }

  private withStore<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.storeLock.then(work, work)
    this.storeLock = turn.catch(() => {})
    return turn
  }

  private bumpVersion(): void {
    this.ctx.storage.sql.exec('INSERT INTO workspace_meta (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version', this.workspaceVersion() + 1)
  }

  /** Deletes the bytes of the given hashes that no file uses any more; returns how many. */
  private async dropUnreferenced(hashes: string[]): Promise<number> {
    const sql = this.ctx.storage.sql
    const unused = hashes.filter((hash) => hash && sql.exec('SELECT 1 FROM workspace_file WHERE hash = ? LIMIT 1', hash).toArray().length === 0)
    for (let i = 0; i < unused.length; i += DELETE_BATCH) await this.env.WORKSPACES.delete(unused.slice(i, i + DELETE_BATCH).map((hash) => this.blobKey(hash)))
    return unused.length
  }

  // Uploads the file list now records are kept; the rest are deleted.
  private async settlePending(): Promise<void> {
    const sql = this.ctx.storage.sql
    const pending = sql.exec<{ hash: string }>('SELECT hash FROM workspace_pending').toArray().map((row) => row.hash)
    if (pending.length === 0) return
    await this.dropUnreferenced(pending)
    for (const hash of pending) sql.exec('DELETE FROM workspace_pending WHERE hash = ?', hash)
  }

  private storedHashes(): string[] {
    return this.ctx.storage.sql.exec<{ hash: string }>("SELECT DISTINCT hash FROM workspace_file WHERE kind = 'file'").toArray().map((row) => row.hash)
  }

  // A file that changed during upload gets its new hash; one that kept changing keeps its previous saved version.
  private applyUpload(files: WorkspaceFile[], uploaded: UploadResult): WorkspaceFile[] {
    const changed = new Map(uploaded.changed.map((file) => [file.path, file]))
    const removed = new Set(uploaded.removed)
    const skipped = new Set(uploaded.skipped)
    const previous = (path: string) =>
      this.ctx.storage.sql.exec<WorkspaceFile>("SELECT path, hash, size, mode, mtime AS mtimeMs, kind, target FROM workspace_file WHERE path = ? AND kind = 'file'", path).toArray()[0]
    return files.flatMap((file) => {
      if (removed.has(file.path)) return []
      if (skipped.has(file.path)) return previous(file.path) ?? []
      return [changed.get(file.path) ?? file]
    })
  }

  private workspaceVersion(): number {
    return this.ctx.storage.sql.exec<{ version: number }>('SELECT version FROM workspace_meta WHERE id = 1').toArray()[0]?.version ?? 0
  }

  private blobKey(hash: string): string {
    return workspaceBlobKey(this.ctx.id.toString(), hash)
  }

  private agentName(): string {
    return this.ctx.id.name ?? this.ctx.id.toString().slice(0, 8)
  }
}

function fileEntry(row: { path: string; size: number; mtime: number }): StoredEntry {
  return {
    name: row.path.slice(row.path.lastIndexOf('/') + 1),
    path: row.path,
    type: 'file',
    size: row.size,
    ...(row.mtime ? { modifiedAt: new Date(row.mtime).toISOString() } : {}),
  }
}
