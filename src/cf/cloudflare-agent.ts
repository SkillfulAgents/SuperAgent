/**
 * One agent's Durable Object. It owns the agent's Cloudflare Container, which SuperAgent's
 * cloudflare-container runner starts and stops through the contract in cloudflare-container-control.ts.
 *
 * The container's disk is empty on every start, so the workspace lives here between runs: each
 * file's bytes in R2 under its content hash, and the list of files (path, hash, size, mode) in this
 * object's SQLite. It is restored before the agent launches; each change is saved a moment after it
 * happens, and the whole workspace again before the container stops. While the agent sleeps, its files are
 * read and written here (the stored* methods).
 *
 * The container app uses the durable_object scheduling policy: this object starts its container on
 * the image the current deploy names, and Cloudflare never rolls a running container onto a new
 * image. A running container keeps its image until it stops; the next start uses the new one.
 *
 * The agent's actor runs here too: its ops come from the rest of the org as RPC calls
 * (`cloudflareAgentActor`), and this object boots SuperAgent to serve them. Calls the actor makes back to
 * the host stay in this isolate, which shares the org's database and AppState. The agent's idle
 * check runs on this object's alarm, which outlives the isolate.
 */
import { DurableObject, type Container, type DurableObjectState, type WorkerWebSocket } from 'cloudflare:workers'
import { ASLEEP_HEADER, type ByteRange, type StoredEntry } from './cloudflare-container-control'
import { runAsAgentObject } from './agent-objects'
import type { ActorOutcome } from './cloudflare-agent-actor'
import { restartIfOlder } from './object-version'
import type { Env } from './index'

// The agent server's port: the image's PORT, SuperAgent's CONTAINER_INTERNAL_PORT. Not imported:
// this module loads when the Worker starts, and the container client pulls in too much for that.
const CONTAINER_INTERNAL_PORT = 3000
// agent-container/cloudflare/snapshot-server.mjs: restores and saves /workspace, then launches the agent.
// The image starts as root here (START_USER in wrangler.jsonc): gamut-start opens /dev/fuse, then runs
// the snapshot server as claude.
const SNAPSHOT_PORT = 8090
const SNAPSHOT_SERVER = ['gamut-start', 'node', '/opt/gamut/cloudflare/snapshot-server.mjs']
// How often a boot checks whether a port in the starting container answers, and for how long.
const PORT_POLL_MS = 50
const PORT_WAIT_MS = 120_000
// How long a stop waits for the container to exit after asking it to.
const EXIT_WAIT_MS = 30_000
// The runtime stops the container once this object has been quiet this long; SuperAgent's own idle check sleeps the agent sooner.
const INACTIVITY_TIMEOUT_MS = 30 * 60_000
// 2 vCPU: on standard-1 (1/2 vCPU) creating a session in the container took about 5.7 s, here about 2.5 s.
const INSTANCE = 'standard-3'
// The hosts the container calls this deploy on: the API, and the saved workspace's bytes.
const HOST = 'host.internal'
const WORKSPACE = 'workspace.internal'
// R2 deletes at most 1,000 keys per call.
const DELETE_BATCH = 1000
// Mode of a file first written while the agent sleeps.
const NEW_FILE_MODE = 0o644
const BLOB = /^\/blobs\/([0-9a-f]{64})$/
// The first idle check after a launch; each check schedules the next at the agent's deadline.
const FIRST_IDLE_CHECK_MS = 60_000

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
 * The container's requests to http://workspace.internal. They run in the Worker (AgentContainerOutbound
 * is a Worker entrypoint), so file bytes go between the container and R2 there,
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
  if (hash && request.method === 'PUT') {
    const length = Number(request.headers.get('x-content-length'))
    if (!request.body || !Number.isInteger(length)) return new Response('x-content-length required', { status: 400 })
    // No call to the agent's object: it marked the hash pending when it asked for these bytes.
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
  return env.AGENT.get(env.AGENT.idFromString(objectId)).workspaceRequest(request)
}

/** The container's calls to the host (proxy, host tools, bootstrap): the API, in the Worker. */
async function serveHostRequest(request: Request, env: Env): Promise<Response> {
  const app = await import('./boot')
  await app.boot(env)
  return app.serveContainerRequest(request, env)
}

/** A container's call to one of this deploy's hosts (AgentContainerOutbound, in the Worker). */
export function serveContainerCall(request: Request, env: Env, containerId: string): Promise<Response> {
  const { hostname } = new URL(request.url)
  if (hostname === HOST) return serveHostRequest(request, env)
  if (hostname === WORKSPACE) return serveWorkspaceRequest(request, env, containerId)
  return Promise.resolve(new Response(null, { status: 404 }))
}

/** A WebSocket the container answered, bridged to a new one for the caller, as a Response can carry only one this request owns. */
function bridgeWebSocket(response: Response, containerSocket: WorkerWebSocket): Response {
  const pair = new WebSocketPair()
  const [client, server] = [pair[0], pair[1]]
  containerSocket.accept()
  server.accept()
  const forward = (from: WorkerWebSocket, to: WorkerWebSocket) => {
    from.addEventListener('message', (event) => {
      try {
        to.send(event.data)
      } catch {
        from.close(1011, 'the other side of the socket is gone')
      }
    })
    // 1005 and 1006 are reserved: they cannot be sent in a close frame.
    from.addEventListener('close', (event) => to.close(event.code === 1005 || event.code === 1006 ? 1000 : event.code, event.reason))
    from.addEventListener('error', () => to.close(1011, 'socket error'))
  }
  forward(server, containerSocket)
  forward(containerSocket, server)
  return new Response(null, { status: response.status, headers: response.headers, webSocket: client } as ResponseInit)
}

export class AgentDurableObject extends DurableObject<Env> {
  // Set while this object watches its running container, so it hears the container exit.
  private watching: Promise<void> | undefined
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const sql = ctx.storage.sql
    sql.exec("CREATE TABLE IF NOT EXISTS workspace_file (path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, mode INTEGER NOT NULL, mtime INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'file', target TEXT)")
    sql.exec('CREATE TABLE IF NOT EXISTS workspace_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)')
    // File bytes stored in R2 but not yet in the file list: a save or write that fails leaves them behind.
    sql.exec('CREATE TABLE IF NOT EXISTS workspace_pending (hash TEXT PRIMARY KEY)')
    // The container outlives this object's memory: a restarted object routes its calls and watches it again.
    if (ctx.container?.running) void ctx.blockConcurrencyWhile(() => this.adoptContainer())
  }

  // Only startAgent may start the container: anything else reaching a stopped one would start it
  // with no env, no restore and no agent. Until the agent is up it reads as asleep.
  async fetch(request: Request): Promise<Response> {
    if (!(await this.agentRunning())) return new Response(null, { status: 503, headers: { [ASLEEP_HEADER]: '1' } })
    return this.containerFetch(request, CONTAINER_INTERNAL_PORT)
  }

  /** SuperAgent's idle check for this agent (checkIdle in boot.ts): sleeps it if idle, else schedules the next check. */
  async checkIdle(): Promise<void> {
    const slug = this.agentName()
    let next: number | null
    try {
      next = await runAsAgentObject(slug, this, async () => {
        const app = await import('./boot')
        await app.boot(this.env)
        await this.syncStatus(app, slug)
        return app.checkIdle(slug)
      })
    } catch (error) {
      console.error(`[AgentDurableObject ${slug}] the idle check failed; will retry:`, error)
      next = Date.now() + FIRST_IDLE_CHECK_MS
    }
    if (next !== null && (await this.agentRunning())) this.scheduleIdleCheck(next)
  }

  // The object's one alarm: it outlives the isolate, and each check sets the next.
  private scheduleIdleCheck(at: number): void {
    this.ctx.storage.setAlarm(at).catch((error: unknown) => {
      console.error(`[AgentDurableObject ${this.agentName()}] scheduling the idle check failed:`, error)
    })
  }

  private async cancelIdleCheck(): Promise<void> {
    await this.ctx.storage.deleteAlarm()
  }

  async alarm(): Promise<void> {
    await this.checkIdle()
  }

  /** One op on this agent's actor, for the rest of the org (cloudflareAgentActor). */
  actorCall(path: string, args: unknown[]): Promise<ActorOutcome> {
    const slug = this.agentName()
    return runAsAgentObject(slug, this, async () => {
      const app = await import('./boot')
      await app.boot(this.env)
      await this.syncStatus(app, slug)
      return app.runAgentActorOp(slug, path, args)
    })
  }

  private syncStatus(app: typeof import('./boot'), slug: string): Promise<void> {
    return (this.statusSynced ??= app.syncAgentStatus(slug).catch((error: unknown) => {
      this.statusSynced = undefined
      console.error(`[AgentDurableObject ${slug}] syncing the container status failed:`, error)
    }))
  }

  private onContainerExit(outcome: string): void {
    this.launched = false
    console.log(`[AgentDurableObject ${this.agentName()}] container exited (${outcome})`)
  }

  checkVersion(callerVersion: string): boolean {
    return restartIfOlder(this.ctx, this.env.VERSION, callerVersion)
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
    await this.startContainer(envVars)
    await this.withStore(() => this.restoreWorkspace())
    await this.containerFetch(new Request('http://container/launch', { method: 'POST' }), SNAPSHOT_PORT)
    await this.waitForPort(CONTAINER_INTERNAL_PORT)
    this.launched = true
    this.scheduleIdleCheck(Date.now() + FIRST_IDLE_CHECK_MS)
    console.log(`[AgentDurableObject ${this.agentName()}] agent launched`)
  }

  /** `discard`: the agent is being deleted, so its container goes without a save. */
  stopAgent(options: { discard?: boolean } = {}): Promise<void> {
    this.stopping ??= (options.discard ? this.discardContainer() : this.shutDown()).finally(() => {
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
    await this.containerExit()
    await this.cancelIdleCheck()
  }

  private async discardContainer(): Promise<void> {
    this.launched = false
    if (await this.containerUp()) await this.destroy()
    await this.cancelIdleCheck()
  }

  // Settles when the watched container exits, or at once when none is watched; gives up after EXIT_WAIT_MS.
  private async containerExit(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.watching, new Promise((resolve) => { timer = setTimeout(resolve, EXIT_WAIT_MS) })])
    clearTimeout(timer)
  }

  /** What the app sees as running: a container that is up and has launched the agent. A half-started or stopping one reads as stopped. */
  async agentRunning(): Promise<boolean> {
    // The container answers /state as launched once the agent's process exists, before its API listens.
    if (this.stopping || this.starting) return false
    return this.agentUp()
  }

  /** Positive evidence that no container process remains: none is up and none is starting. */
  async containerStopped(): Promise<boolean> {
    return !this.starting && !(await this.containerUp())
  }

  /** Records bytes the Worker is about to store for this agent (serveWorkspaceRequest). */
  /** The container's saves of what changed; its file bytes go to R2 in the Worker. */
  async workspaceRequest(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/changes' && request.method === 'POST') {
      const { entries, removed, uploaded = [] } = (await request.json()) as { entries: WorkspaceFile[]; removed: string[]; uploaded?: string[] }
      return this.saveChanges(entries, removed, uploaded)
    }
    return new Response(null, { status: 404 })
  }

  /**
   * Files the running container changed or removed, saved seconds after the change, so a crash loses
   * only those seconds. Answers 409 with the hashes it needs: the container uploads them and sends
   * again, naming the ones it uploaded.
   */
  private saveChanges(entries: WorkspaceFile[], removed: string[], uploaded: string[]): Promise<Response> {
    return this.withStore(async () => {
      if (!(await this.agentUp())) return new Response('the agent is not running', { status: 409 })
      const missing = this.missingBlobs(entries, uploaded)
      if (missing.length > 0) return Response.json({ missing }, { status: 409 })
      // Bytes are dropped after both: a rename removes a path and adds one with the same bytes.
      const released = removed.flatMap((rel) => this.removeSaved(rel))
      if (entries.length > 0) released.push(...this.recordFiles(entries))
      await this.dropUnreferenced(released)
      return new Response(null, { status: 204 })
    })
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
        // Changes the container sends meanwhile wait, then land on top: they are newer than its scan.
        saved = await this.withStore(() => this.writeWorkspace())
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

  // Streamed, not read whole: a large file would not fit in the object's memory.
  async storedRead(rel: string, range?: ByteRange): Promise<{ size: number; stream: ReadableStream<Uint8Array> } | null> {
    const row = this.ctx.storage.sql.exec<{ hash: string; size: number }>("SELECT hash, size FROM workspace_file WHERE path = ? AND kind = 'file'", rel).toArray()[0]
    if (!row) return null
    const r2Range = range && { offset: range.start, ...(range.end === undefined ? {} : { length: range.end - range.start + 1 }) }
    const object = await this.env.WORKSPACES.get(this.blobKey(row.hash), r2Range ? { range: r2Range } : undefined)
    return object ? { size: row.size, stream: object.body } : null
  }

  /** False when the agent is running: the write has to go to its container. */
  storedWrite(rel: string, bytes: Uint8Array): Promise<boolean> {
    return this.storeChange(async () => {
      const hash = hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
      const sql = this.ctx.storage.sql
      sql.exec('INSERT OR IGNORE INTO workspace_pending (hash) VALUES (?)', hash)
      await this.env.WORKSPACES.put(this.blobKey(hash), bytes)
      const previous = sql.exec<{ mode: number }>('SELECT mode FROM workspace_file WHERE path = ?', rel).toArray()[0]
      await this.dropUnreferenced(this.recordFiles([{ path: rel, hash, size: bytes.byteLength, mode: previous?.mode ?? NEW_FILE_MODE, mtimeMs: Date.now(), kind: 'file' }]))
      await this.settlePending()
    })
  }

  /** Removes a file, or a folder with everything under it. False when the agent is running. */
  storedRemove(rel: string): Promise<boolean> {
    return this.storeChange(async () => {
      await this.dropUnreferenced(this.removeSaved(rel))
    })
  }

  // Sets these entries in the saved file list. Returns the hashes they replaced, for the caller to drop.
  private recordFiles(files: WorkspaceFile[]): string[] {
    const sql = this.ctx.storage.sql
    const replaced: string[] = []
    this.ctx.storage.transactionSync(() => {
      for (const file of files) {
        const previous = sql.exec<{ hash: string }>('SELECT hash FROM workspace_file WHERE path = ?', file.path).toArray()[0]
        if (previous?.hash && previous.hash !== file.hash) replaced.push(previous.hash)
        sql.exec(
          'INSERT INTO workspace_file (path, hash, size, mode, mtime, kind, target) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET hash = excluded.hash, size = excluded.size, mode = excluded.mode, mtime = excluded.mtime, kind = excluded.kind, target = excluded.target',
          file.path, file.hash, file.size, file.mode, Math.round(file.mtimeMs ?? 0), file.kind ?? 'file', file.target ?? null,
        )
      }
      this.bumpVersion()
    })
    return replaced
  }

  // Removes a file, or a folder with everything under it, from the saved file list. Returns their hashes, for the caller to drop.
  private removeSaved(rel: string): string[] {
    const sql = this.ctx.storage.sql
    const match = 'path = ? OR substr(path, 1, ?) = ?'
    const hashes = sql.exec<{ hash: string }>(`SELECT DISTINCT hash FROM workspace_file WHERE ${match}`, rel, rel.length + 1, `${rel}/`).toArray().map((row) => row.hash)
    if (hashes.length === 0) return []
    this.ctx.storage.transactionSync(() => {
      sql.exec(`DELETE FROM workspace_file WHERE ${match}`, rel, rel.length + 1, `${rel}/`)
      this.bumpVersion()
    })
    return hashes
  }

  /**
   * Hashes of these files whose bytes this object cannot vouch for: no saved file uses them, and the
   * container has not uploaded them since this object asked. They are marked pending before the
   * container uploads them, so bytes no file ends up using are dropped (settlePending). An upload
   * counts only while its hash is still pending: a save may have dropped the bytes meanwhile.
   * Checked here, not in R2: one R2 request per new file made a save of many files take tens of seconds.
   */
  private missingBlobs(files: WorkspaceFile[], uploaded: string[]): string[] {
    const sql = this.ctx.storage.sql
    const sent = new Set(uploaded)
    const used = (hash: string) => sql.exec('SELECT 1 FROM workspace_file WHERE hash = ? LIMIT 1', hash).toArray().length > 0
    const pending = (hash: string) => sql.exec('SELECT 1 FROM workspace_pending WHERE hash = ?', hash).toArray().length > 0
    const hashes = [...new Set(files.filter((file) => (file.kind ?? 'file') === 'file').map((file) => file.hash))]
    const missing = hashes.filter((hash) => !used(hash) && !(sent.has(hash) && pending(hash)))
    for (const hash of missing) sql.exec('INSERT OR IGNORE INTO workspace_pending (hash) VALUES (?)', hash)
    return missing
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
    return this.container.running
  }

  private get container(): Container {
    const container = this.ctx.container
    if (!container) throw new Error('AgentDurableObject has no container: its Worker config links none')
    return container
  }

  // Calls to the deploy's hosts are routed before the container starts, as it may call them at once.
  private async startContainer(env: Record<string, string>): Promise<void> {
    await this.routeContainerCalls()
    this.container.start({ image: this.container.images.agent, instance: INSTANCE, enableInternet: true, entrypoint: SNAPSHOT_SERVER, env })
    this.watchContainer()
    await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
    await this.waitForPort(SNAPSHOT_PORT)
  }

  private async adoptContainer(): Promise<void> {
    await this.routeContainerCalls()
    await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
    this.watchContainer()
  }

  private async routeContainerCalls(): Promise<void> {
    const outbound = this.ctx.exports.AgentContainerOutbound({ props: { containerId: this.ctx.id.toString() } })
    for (const host of [HOST, WORKSPACE]) await this.container.interceptOutboundHttp(host, outbound)
  }

  private watchContainer(): void {
    this.watching ??= this.container.monitor().then(
      () => this.onContainerExit('code 0'),
      (error: unknown) => this.onContainerExit(String(error)),
    ).finally(() => {
      this.watching = undefined
    })
  }

  // start() returns before the process listens: a port is ready once a request to it gets any answer.
  private async waitForPort(port: number): Promise<void> {
    const deadline = Date.now() + PORT_WAIT_MS
    for (;;) {
      if (!this.container.running) throw new Error(`The container of agent ${this.agentName()} exited while starting`)
      try {
        const response = await this.container.getTcpPort(port).fetch(new Request('http://container/'))
        await response.body?.cancel()
        return
      } catch (error) {
        if (Date.now() > deadline) throw new Error(`Port ${port} of agent ${this.agentName()}'s container did not open`, { cause: error })
        await new Promise((resolve) => setTimeout(resolve, PORT_POLL_MS))
      }
    }
  }

  private async containerFetch(request: Request, port: number): Promise<Response> {
    const response = await this.container.getTcpPort(port).fetch(new Request(request.url.replace('https:', 'http:'), request))
    const socket = (response as Response & { webSocket?: WorkerWebSocket | null }).webSocket
    return socket ? bridgeWebSocket(response, socket) : response
  }

  /** Asks the container to stop (SIGTERM); its snapshot server saves the last changes, then exits. */
  private async stop(): Promise<void> {
    // An agent that never started has no container to signal, and Cloudflare throws on one that is not running.
    if (this.container.running) this.container.signal(15)
  }

  private async destroy(): Promise<void> {
    await this.container.destroy()
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
        for (const hash of missing) sql.exec('INSERT OR IGNORE INTO workspace_pending (hash) VALUES (?)', hash)
        const upload = await this.containerFetch(new Request('http://container/upload', { method: 'POST', body: JSON.stringify({ hashes: missing }) }), SNAPSHOT_PORT)
        if (!upload.ok) throw new Error(`upload returned ${upload.status}: ${await upload.text()}`)
        uploaded = (await upload.json()) as UploadResult
        // Files that changed during the upload went up under new hashes.
        for (const file of uploaded.changed) if (file.hash) sql.exec('INSERT OR IGNORE INTO workspace_pending (hash) VALUES (?)', file.hash)
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
      console.log(`[AgentDurableObject ${this.agentName()}] saved workspace version ${version}: ${files.length} entries, ${missing.length} uploaded, ${dropped} removed`)
      return true
    } catch (error) {
      console.error(`[AgentDurableObject ${this.agentName()}] workspace save failed; keeping the previous one:`, error)
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
