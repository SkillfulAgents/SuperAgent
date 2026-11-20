/**
 * One agent's Durable Object. It owns the agent's Cloudflare Container, which SuperAgent's
 * cloudflare-container runner starts and stops through the contract in cloudflare-container-control.ts.
 *
 * The container's disk is empty on every start, so the workspace lives here between runs: each
 * file's bytes in R2 under its content hash, and the list of files (path, hash, size, mode) in this
 * object's SQLite. It is restored before the agent launches; each change is saved a moment after it
 * happens, and the whole workspace again before the container stops. While the agent sleeps, its files are
 * read and written here (the stored* methods). The saved record itself is lib/saved-workspace.ts; this
 * object decides when it may change.
 *
 * The container app uses the durable_object scheduling policy: this object starts its container on
 * the image the current deploy names, and Cloudflare never rolls a running container onto a new
 * image. A running container keeps its image until it stops; the next start uses the new one.
 */
import { DurableObject, type Container, type DurableObjectState, type WorkerWebSocket } from 'cloudflare:workers'
import { ASLEEP_HEADER, type ByteRange, type StoredEntry, type StoredRefusal } from '../cloudflare-container-control'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { needsLiveConnections, serveInTaskManager } from './cloudflare-task-manager'
import { captureException } from '@shared/lib/error-reporting'
import { containerSnapshotFrom, snapshotStartCommand, type ContainerSnapshot } from '../lib/container-snapshot'
import { SavedWorkspace, isHash, isList, isWorkspaceFile, isWorkspacePath, workspaceBlobKey, type UploadResult, type WorkspaceFile } from '../lib/saved-workspace'
import type { Env } from '../index'
import { nearStorage } from '../lib/object-location'

// The agent server's port: the image's PORT, SuperAgent's CONTAINER_INTERNAL_PORT. Not imported:
// this module loads when the Worker starts, and the container client pulls in too much for that.
const CONTAINER_INTERNAL_PORT = 3000
// container/cf-workspace-server.mjs: restores and saves /workspace, launches the agent, and adds to its files.
// The image starts as root here (container/Dockerfile): gamut-start opens /dev/fuse, then runs
// the cf-workspace-server as claude.
const WORKSPACE_SERVER_PORT = 8090
const WORKSPACE_SERVER = ['gamut-start', 'node', '/opt/gamut/cloudflare/cf-workspace-server.mjs']
// How often a boot checks whether a port in the starting container answers, and for how long.
const PORT_POLL_MS = 50
const PORT_WAIT_MS = 120_000
// How long a stop waits for the container to exit after asking it to.
const EXIT_WAIT_MS = 30_000
// How long a failed start waits for its container to say where it ran, for the report.
const LOCATION_WAIT_MS = 2_000
// How often and how far apart a container is asked whether it launched the agent, before its silence counts as no answer.
const STATE_TRIES = 3
const STATE_RETRY_MS = 200
// The runtime stops the container once this object has been quiet this long; SuperAgent's own idle check sleeps the agent sooner.
const INACTIVITY_TIMEOUT_MS = 30 * 60_000
/** How long after the last change to a sleeping agent's files their work in R2 starts. */
const SETTLE_AFTER_MS = 2_000
// 2 vCPU: on standard-1 (1/2 vCPU) creating a session in the container took about 5.7 s, here about 2.5 s.
// A deployment picks another size with AGENT_INSTANCE_TYPE.
const INSTANCE = 'standard-3'
// The hosts the container calls this deploy on: the API, and the saved workspace's bytes.
const HOST = 'host.internal'
const WORKSPACE = 'workspace.internal'
const BLOB = /^\/blobs\/([0-9a-f]{64})$/

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
    const sent = request.headers.get('x-content-length') ?? ''
    if (!request.body || !/^\d+$/.test(sent)) return new Response('x-content-length required', { status: 400 })
    const length = Number(sent)
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
  if (needsLiveConnections(new URL(request.url).pathname)) return serveInTaskManager(request, env)
  const app = await import('../boot')
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
export function bridgeWebSocket(response: Response, containerSocket: WorkerWebSocket): Response {
  const pair = new WebSocketPair()
  const [client, server] = [pair[0], pair[1]]
  containerSocket.accept()
  server.accept()
  const forward = (from: WorkerWebSocket, to: WorkerWebSocket) => {
    // A binary message can arrive as a Blob, which send() would turn into the text "[object Blob]".
    // Its bytes are read in order, so a later message never overtakes it.
    let sending: Promise<void> = Promise.resolve()
    from.addEventListener('message', (event) => {
      const data = event.data as string | ArrayBuffer | Blob
      sending = sending.then(async () => {
        to.send(data instanceof Blob ? await data.arrayBuffer() : data)
      }).catch(() => {
        from.close(1011, 'the other side of the socket is gone')
      })
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
  private settleTimer?: ReturnType<typeof setTimeout>
  // Restoring on wake and changing the saved workspace take turns, so a change can't land after a restore read the list.
  private storeLock: Promise<unknown> = Promise.resolve()
  private readonly workspace: SavedWorkspace

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, nearStorage(env))
    this.workspace = new SavedWorkspace(ctx.storage, env.WORKSPACES, ctx.id.toString())
    // Held bytes a stopped object left behind go to R2 now.
    if (this.workspace.hasHeldBytes()) this.settleLater([])
    // The container outlives this object's memory: a restarted object routes its calls and watches it again.
    if (ctx.container?.running) void ctx.blockConcurrencyWhile(() => this.adoptContainer())
  }

  // Only startAgent may start the container: anything else reaching a stopped one would start it
  // with no env, no restore and no agent. Until the agent is up it reads as asleep.
  async fetch(request: Request): Promise<Response> {
    if (!(await this.agentRunning())) return new Response(null, { status: 503, headers: { [ASLEEP_HEADER]: '1' } })
    return this.containerFetch(request, CONTAINER_INTERNAL_PORT)
  }

  private onContainerExit(outcome: string): void {
    this.launched = false
    console.log(`[AgentDurableObject ${this.agentName()}] container exited (${outcome})`)
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
      const launched = await this.agentLaunched()
      if (launched) return
      // No answer is not "no agent": its agent may be running, with work not yet saved (agentUp).
      if (launched === null) throw new Error(`The container of agent ${this.agentName()} is up but does not answer, so no new one is started over it`)
      // Running without a launched agent: it was not started here, so it has neither the env nor the workspace.
      await this.destroy()
    }
    await this.startContainer(envVars)
    await this.withStore(() => this.restoreWorkspace())
    await this.containerFetch(new Request('http://container/launch', { method: 'POST' }), WORKSPACE_SERVER_PORT)
    await this.waitForPort(CONTAINER_INTERNAL_PORT)
    this.launched = true
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
  }

  private async discardContainer(): Promise<void> {
    this.launched = false
    if (await this.containerUp()) await this.destroy()
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

  /** The container's saves of what changed; its file bytes go to R2 in the Worker. */
  async workspaceRequest(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/changes' && request.method === 'POST') {
      const { entries, removed, uploaded = [] } = (await request.json()) as { entries: unknown; removed: unknown; uploaded?: unknown }
      // The agent's own code can reach this endpoint: only well-formed entries inside the workspace are saved.
      if (!isList(entries, isWorkspaceFile) || !isList(removed, isWorkspacePath) || !isList(uploaded, isHash)) {
        return new Response('malformed changes', { status: 400 })
      }
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
      const missing = this.workspace.missingBlobs(entries, uploaded)
      if (missing.length > 0) return Response.json({ missing }, { status: 409 })
      // Bytes are dropped after both: a rename removes a path and adds one with the same bytes.
      const released = removed.flatMap((rel) => this.workspace.remove(rel))
      if (entries.length > 0) released.push(...this.workspace.record(entries))
      await this.workspace.dropUnreferenced(released)
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
    return this.workspace.entry(rel)
  }

  async storedRead(rel: string, range?: ByteRange): Promise<{ size: number; stream: ReadableStream<Uint8Array> } | null> {
    return this.workspace.read(rel, range)
  }

  /** False when the agent is running: the write has to go to its container. */
  storedWrite(rel: string, bytes: Uint8Array, mode?: number): Promise<boolean | StoredRefusal> {
    return refusedAs(this.storeChange(async () => this.settleLater(await this.workspace.write(rel, bytes, mode))))
  }

  /**
   * Adds bytes to the end of a file, or makes it, wherever the agent's files are now. While the agent
   * runs, the container's cf-workspace-server does one write at the end of the file, so the bytes
   * land whole next to what the agent's own process appends (a session's transcript). While it
   * sleeps, each append takes a turn of the saved workspace, so two made at the same time both land.
   */
  async appendToFile(rel: string, bytes: Uint8Array): Promise<'done' | StoredRefusal> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.agentRunning()) {
        const request = new Request(`http://container/append?path=${encodeURIComponent(rel)}`, { method: 'POST', body: bytes as Uint8Array<ArrayBuffer> })
        const response = await this.containerFetch(request, WORKSPACE_SERVER_PORT)
        if (response.status === 409) return 'not-a-file'
        if (!response.ok) throw new Error(`Adding to ${rel} in the container of agent ${this.agentName()} failed: ${response.status} ${await response.text()}`)
        await response.body?.cancel()
        return 'done'
      }
      if (Array.isArray(this.workspace.entry(rel))) return 'not-a-file'
      // False: the agent started meanwhile, so the bytes go to its container.
      const appended = await refusedAs(this.storeChange(async () => this.settleLater(await this.workspace.append(rel, bytes))))
      if (appended === true) return 'done'
      if (appended) return appended
    }
    throw new Error(`The container of agent ${this.agentName()} kept starting and stopping`)
  }

  /** Keeps an empty folder, unless something is already at the path or under it. False when the agent is running. */
  storedMkdir(rel: string): Promise<boolean | StoredRefusal> {
    return refusedAs(this.storeChange(async () => this.workspace.mkdir(rel)))
  }

  /** Removes a file, or a folder with everything under it. False when the agent is running. */
  storedRemove(rel: string): Promise<boolean> {
    return this.storeChange(async () => this.settleLater(this.workspace.remove(rel)))
  }

  /**
   * What a change leaves to do in R2: held bytes are written there, and bytes no file uses any
   * more are deleted (their hashes are marked pending first, so a later change or save drops them
   * if this object stops before). It waits until changes have stopped coming, so a caller that
   * writes several files does not wait on R2 between them, then takes a turn of the store.
   */
  private settleLater(replaced: string[]): void {
    this.workspace.markPending(replaced)
    clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      void this.withStore(async () => {
        await this.workspace.uploadHeld()
        await this.workspace.settlePending()
      }).catch((error: unknown) => {
        console.error(`[AgentDurableObject ${this.agentName()}] settling the saved workspace in R2 failed:`, error)
      })
    }, SETTLE_AFTER_MS)
  }

  /** Deletes the agent's saved workspace, its files in R2 and its file list, after the agent is deleted. */
  purgeWorkspace(): Promise<void> {
    return this.withStore(async () => {
      if (await this.containerUp()) await this.destroy()
      this.launched = false
      await this.workspace.purge()
    })
  }

  private async agentUp(): Promise<boolean> {
    if (!(await this.containerUp())) return false
    const launched = await this.agentLaunched()
    if (launched) return true
    // Up with no agent and not starting: nothing will launch it, and it holds an instance slot.
    // A container that gave no answer is left alone: its agent may be running, with work not yet saved.
    if (launched === false && !this.starting) await this.destroy()
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

  // From the deployment's container snapshot when it names one, and from the image when it names
  // none or the snapshot start fails: an agent must start either way.
  private async startContainer(env: Record<string, string>): Promise<void> {
    const snapshot = this.containerSnapshot()
    if (snapshot) {
      try {
        await this.startFrom({ containerSnapshot: snapshot, entrypoint: snapshotStartCommand(WORKSPACE_SERVER) }, env)
        console.log(`[AgentDurableObject ${this.agentName()}] container started from snapshot ${snapshot.name}`)
        return
      } catch (error) {
        await this.fallBackToImage(`starting from container snapshot ${snapshot.name} failed`, error, { snapshot: snapshot.name })
      }
    }
    await this.startFrom({ image: this.container.images.agent, entrypoint: WORKSPACE_SERVER }, env)
  }

  private async startFrom(source: { image: string; entrypoint: string[] } | { containerSnapshot: ContainerSnapshot; entrypoint: string[] }, env: Record<string, string>): Promise<void> {
    // Calls to the deploy's hosts are routed before each start, as the container may call them at once:
    // the routes of a container that was destroyed do not carry over to the next one.
    await this.routeContainerCalls()
    this.container.start({ ...source, instance: this.env.AGENT_INSTANCE_TYPE?.trim() || INSTANCE, enableInternet: true, env })
    this.watchContainer()
    await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
    await this.waitForPort(WORKSPACE_SERVER_PORT)
  }

  /** The deployment's container snapshot, or null when it names none. A value that is not a snapshot handle is a fallback too. */
  private containerSnapshot(): ContainerSnapshot | null {
    try {
      return containerSnapshotFrom(this.env.CONTAINER_SNAPSHOT)
    } catch (error) {
      this.reportFallback('the container snapshot is not usable', error, { location: 'not started' })
      return null
    }
  }

  /** Reports a snapshot start that failed, with where its container ran, and clears that container away so the image can start. */
  private async fallBackToImage(what: string, error: unknown, extra: Record<string, unknown>): Promise<void> {
    this.reportFallback(what, error, { ...extra, location: await this.containerLocation() })
    if (this.container.running) await this.destroy().catch(() => {})
    await this.containerExit()
  }

  private reportFallback(what: string, error: unknown, extra: Record<string, unknown>): void {
    console.error(`[AgentDurableObject ${this.agentName()}] ${what} (container location: ${String(extra.location)}); starting from the image:`, error)
    captureException(error, { tags: { component: 'agent-object', operation: 'snapshot-start-fallback' }, extra: { agent: this.agentName(), ...extra }, level: 'warning' })
  }

  /** Where Cloudflare placed the running container, or 'unknown' when there is none or it does not answer in time. */
  private async containerLocation(): Promise<string> {
    if (!this.container.running) return 'unknown'
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const asked = (async () => {
        const process = await this.container.exec(['sh', '-c', 'tr "\\0" "\\n" < /proc/1/environ | grep "^CLOUDFLARE_LOCATION="'], { stderr: 'ignore' })
        return new TextDecoder().decode((await process.output()).stdout).trim().split('=')[1]
      })()
      const late = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), LOCATION_WAIT_MS)
      })
      return (await Promise.race([asked, late])) || 'unknown'
    } catch {
      return 'unknown'
    } finally {
      clearTimeout(timer)
    }
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

  /** Asks the container to stop (SIGTERM); its cf-workspace-server saves the last changes, then exits. */
  private async stop(): Promise<void> {
    // An agent that never started has no container to signal, and Cloudflare throws on one that is not running.
    if (this.container.running) this.container.signal(15)
  }

  private async destroy(): Promise<void> {
    await this.container.destroy()
  }

  /** Whether the container launched the agent, as its cf-workspace-server answers; null when it gives no answer. */
  private async agentLaunched(): Promise<boolean | null> {
    if (this.launched) return true
    for (let attempt = 0; attempt < STATE_TRIES; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, STATE_RETRY_MS))
      try {
        const response = await this.containerFetch(new Request('http://container/state'), WORKSPACE_SERVER_PORT)
        if (response.ok) return (this.launched = ((await response.json()) as { launched: boolean }).launched === true)
        await response.body?.cancel()
      } catch {
        // Asked again.
      }
    }
    return null
  }

  /** True when saved, or when there is nothing to save: no agent ran on this container's workspace. */
  private async writeWorkspace(): Promise<boolean> {
    // Only a workspace the agent ran on (restored, then launched) may replace the saved one.
    if (!(await this.agentUp())) return true
    const workspace = this.workspace
    try {
      // Bytes a failed save uploaded and no file uses.
      await workspace.settlePending()
      const scan = await this.containerFetch(new Request('http://container/scan', { method: 'POST' }), WORKSPACE_SERVER_PORT)
      if (!scan.ok) throw new Error(`scan returned ${scan.status}: ${await scan.text()}`)
      let { files } = (await scan.json()) as { files: WorkspaceFile[] }
      if (!isList(files, isWorkspaceFile)) throw new Error('scan returned an entry that is malformed or outside the workspace')
      const stored = new Set(workspace.storedHashes())
      const kept = new Set(files.filter((file) => (file.kind ?? 'file') === 'file').map((file) => file.hash))
      const missing = [...kept].filter((hash) => !stored.has(hash))
      if (missing.length > 0) {
        workspace.markPending(missing)
        const upload = await this.containerFetch(new Request('http://container/upload', { method: 'POST', body: JSON.stringify({ hashes: missing }) }), WORKSPACE_SERVER_PORT)
        if (!upload.ok) throw new Error(`upload returned ${upload.status}: ${await upload.text()}`)
        const uploaded = (await upload.json()) as UploadResult
        // Files that changed during the upload went up under new hashes.
        workspace.markPending(uploaded.changed.map((file) => file.hash).filter(Boolean))
        files = workspace.applyUpload(files, uploaded)
      }
      const version = workspace.replaceAll(files)
      const dropped = await workspace.dropUnreferenced([...stored])
      await workspace.settlePending()
      console.log(`[AgentDurableObject ${this.agentName()}] saved workspace version ${version}: ${files.length} entries, ${missing.length} uploaded, ${dropped} removed`)
      return true
    } catch (error) {
      console.error(`[AgentDurableObject ${this.agentName()}] workspace save failed; keeping the previous one:`, error)
      captureException(error, { tags: { component: 'agent-object', operation: 'save-workspace' }, extra: { agent: this.agentName() } })
      return false
    }
  }

  private async restoreWorkspace(): Promise<void> {
    // The container reads every file from R2.
    await this.workspace.uploadHeld()
    const files = this.workspace.files()
    if (files.length === 0) return
    const response = await this.containerFetch(new Request('http://container/restore', { method: 'POST', body: JSON.stringify({ files }) }), WORKSPACE_SERVER_PORT)
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

  private agentName(): string {
    return this.ctx.id.name ?? this.ctx.id.toString().slice(0, 8)
  }
}

/** A change the saved workspace refused, as its code (StoredRefusal); any other failure is thrown on. */
async function refusedAs(change: Promise<boolean>): Promise<boolean | StoredRefusal> {
  try {
    return await change
  } catch (error) {
    if (error instanceof WorkspaceFileError && (error.code === 'not-a-file' || error.code === 'not-a-directory')) return error.code
    throw error
  }
}
