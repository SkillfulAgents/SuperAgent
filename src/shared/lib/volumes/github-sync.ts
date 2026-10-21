import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ReadableStream } from 'node:stream/web'
import * as tar from 'tar'
import ignore from 'ignore'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { errnoCode } from '@shared/lib/agent-actor/local-file-ops'
import { readJsonFileStrict, writeJsonFileAtomic } from '@shared/lib/utils/file-storage'
import { LocalMountableVolume } from './local-mountable-volume'
import type { VolumeFile } from './base-mountable-volume'
import { VolumeError, VolumePreparingError } from './volume-error'
import { serialize } from './remote-listing-cache'
import { throwIfUploadAborted, uploadChunks } from './remote-transfer'
import { githubBlob, githubCommit, githubHead, githubRepo, githubTarball, githubTree } from './github-client'
import { githubEditsSchema, type GithubEdits, type GithubFile, type GithubVolumeConfig, type SyncState } from './github-schema'
import { blobSha, emptySyncState, loadSyncState, saveSyncState, snapshotCollisions, fileBlobSha, volumeFolder } from './github-sync-state'
import { GITHUB_PUSH_BYTES, mergePath, planPush, type PushChange } from './github-merge'

const syncs = new Map<string, GithubSync>()
/** A read never shows the branch older than this, as Google Drive's listing cache allows. */
const FRESH_MS = 30_000
/** How long a stale read waits for the check before serving the copy. The proxy can hold a request while an account reconnects. */
const FRESH_WAIT_MS = 5_000
type GithubVolume = { id: string; name: string; config: GithubVolumeConfig }
const PUSH_DELAY = 15_000
/** A drive written to without pause still pushes this long after its first unpushed write. */
const PUSH_MAX_DELAY = 120_000
const emptyEdits = (): GithubEdits => ({ version: 1, unpushed: {}, held: {}, stopped: null, ignores: [], links: [] })
/** A record's own entry: paths like `constructor` must not read through the prototype. */
const own = <T>(record: Record<string, T>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(errnoCode(error) ?? '')

export class GithubSync {
  readonly folder: string
  private readonly key: string
  private localVolume: LocalMountableVolume | null = null
  state = emptySyncState()
  edits = emptyEdits()
  private loading: Promise<void> | null = null
  private prepared = false
  private caseInsensitive = false
  private syncing: Promise<void> | null = null
  private checkedAt = 0
  private waitUntil = 0
  private removed = false
  private failure: string | null = null
  private clash: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingSince: number | null = null
  private pushWanted = false
  /** Per mount and path, every version served since that mount last wrote it. The first is what an upload merges against. */
  private served = new Map<string, Map<string, (string | null)[]>>()
  /** Per mount and path, what it last uploaded: its base until it reads again, since it still holds those bytes. */
  private sent = new Map<string, Map<string, string>>()
  private policyHeld = new Map<string, string>()
  private rules = new Map<string, string>()
  private written = new Map<string, Buffer>()
  /** Paths whose large upload is still streaming: a push must neither send nor clear them. */
  private writing = new Set<string>()

  constructor(readonly volume: GithubVolume) {
    this.folder = volumeFolder(volume.id)
    this.key = `github:${volume.id}`
  }

  get local(): LocalMountableVolume {
    if (!this.localVolume) throw new VolumePreparingError()
    return this.localVolume
  }

  get loaded(): Promise<void> {
    return this.loading ??= this.load().catch(error => { this.loading = null; throw error })
  }
  get isReady(): boolean { return this.prepared }
  get stopped(): string | null { return this.edits.stopped }
  get unpushed(): number { return Object.keys(this.edits.unpushed).length }
  private get pending(): boolean {
    return Object.keys(this.edits.unpushed).some(name => !own(this.edits.held, name) && !this.policyHeld.has(name))
  }

  get attention(): string | null {
    const held = new Map([...this.policyHeld, ...Object.entries(this.edits.held).map(([name, hold]) => [name, hold.reason] as const)])
    const count = new Set([...Object.keys(this.edits.unpushed), ...held.keys()]).size
    const parts = [
      this.edits.stopped ? `Pushes stopped: ${this.edits.stopped}` : this.prepared && this.failure ? `Sync paused: ${this.failure}` : null,
      count ? `${count} ${count === 1 ? 'file' : 'files'} not on GitHub yet` : null,
      ...[...held].slice(0, 3).map(([name, reason]) => `${name} (${reason})`),
      held.size > 3 ? `${held.size - 3} more held` : null,
    ]
    return parts.filter(Boolean).join(' · ') || null
  }

  async unsynced(): Promise<number | null> {
    if (!await this.loaded.then(() => true, () => false)) return null
    return new Set([...Object.keys(this.edits.unpushed), ...Object.keys(this.edits.held)]).size
  }

  private checkRemoved(): void {
    if (this.removed) throw new WorkspaceFileError('not-found')
  }

  private async load(): Promise<void> {
    this.checkRemoved()
    await fs.rm(path.join(this.folder, 'pull'), { recursive: true, force: true })
    this.state = await loadSyncState(this.folder)
    this.edits = await readJsonFileStrict(path.join(this.folder, 'edits.json'), githubEditsSchema, emptyEdits())
    const copy = path.join(this.folder, 'copy')
    const existing = await fs.lstat(copy).catch(error => {
      if (errnoCode(error) === 'ENOENT') return null
      throw error
    })
    this.checkRemoved()
    await fs.mkdir(this.folder, { recursive: true })
    const probe = path.join(this.folder, `case-${randomUUID()}-a`)
    try {
      this.checkRemoved()
      await fs.writeFile(probe, '')
      this.caseInsensitive = await fs.stat(probe.slice(0, -1) + 'A').then(() => true, () => false)
    } finally { await fs.rm(probe, { force: true }) }
    const resolved = existing && !existing.isSymbolicLink()
      ? await fs.realpath(copy) : path.join(await fs.realpath(this.folder), 'copy')
    this.localVolume = new LocalMountableVolume(this.volume.id, this.volume.name, { path: resolved })
    this.prepared = this.state.base !== null && existing?.isDirectory() === true && !existing.isSymbolicLink()
  }

  async ready(): Promise<void> {
    if (!this.removed) await this.loaded.catch(() => {})
    if (this.removed) throw new WorkspaceFileError('not-found')
    if (!this.prepared) {
      if (this.clash) throw new WorkspaceFileError('not-accessible', this.clash)
      throw new VolumePreparingError(this.failure ?? undefined)
    }
  }

  keepFresh(): void {
    if (this.removed) return
    void this.loaded.then(() => { if (this.pending && !this.timer) this.schedulePush() }, () => {})
    if (this.syncing || this.checkedAt > Date.now() - FRESH_MS) return
    void this.run()
  }

  /** Before a read: a copy checked over 30 s ago waits for the check. Every read waiting on one check shares its 5 s. */
  async fresh(): Promise<void> {
    if (this.removed) return
    await this.loaded.catch(() => {})
    if (this.pending && !this.timer) this.schedulePush()
    if (!this.prepared) return this.keepFresh()
    if (!this.syncing) {
      if (this.checkedAt > Date.now() - FRESH_MS) return
      this.waitUntil = Date.now() + FRESH_WAIT_MS
    }
    const left = this.waitUntil - Date.now()
    if (left <= 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.run(), new Promise<void>(resolve => { timer = setTimeout(resolve, left) })])
    clearTimeout(timer)
  }

  private schedulePush(): void {
    this.forget()
    if (this.removed || this.edits.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.pendingSince ??= Date.now()
    const delay = Math.min(PUSH_DELAY, Math.max(0, this.pendingSince + PUSH_MAX_DELAY - Date.now()))
    this.timer = setTimeout(() => { this.timer = null; this.pendingSince = null; void this.run(true) }, delay)
    this.timer.unref?.()
  }

  async run(push = false): Promise<void> {
    if (push) this.pushWanted = true
    if (this.removed) return
    if (this.syncing) {
      await this.syncing
      if (push && this.pushWanted) this.schedulePush()
      return
    }
    this.syncing = (async () => {
      try {
        this.checkedAt = Date.now()
        await this.loaded
        if (!this.prepared || this.state.base === null) await this.stage()
        else {
          const head = await this.checkBranch()
          if (head === null) return
          await this.pull(head)
          if (this.pushWanted) { this.pushWanted = false; await this.push() }
        }
        this.failure = null
      } catch (error) {
        if (this.removed) return
        this.failure = error instanceof VolumeError || error instanceof WorkspaceFileError ? error.message : 'GitHub copy failed'
        if (error instanceof VolumeError && (error.status === 503 || error.status === 429) && this.pending) this.schedulePush()
        console.warn(`[volumes] GitHub sync ${this.volume.id}: ${this.failure}`)
      } finally {
        if (this.removed) await removeCopy(this.volume.id)
      }
    })().finally(() => { this.syncing = null })
    await this.syncing
  }

  private async checkBranch(): Promise<string | null> {
    try {
      if (this.edits.stopped) {
        const repo = await githubRepo(this.volume.config)
        if (repo.archived || repo.permissions?.push === false) return null
      }
      const head = await githubHead(this.volume.config)
      if (this.edits.stopped) {
        this.edits.stopped = null
        await this.saveEdits()
        this.pushWanted ||= this.unpushed > 0
      }
      return head
    } catch (error) {
      if (error instanceof WorkspaceFileError && this.edits.stopped !== error.message) {
        this.edits.stopped = error.message
        await this.saveEdits()
      }
      throw error
    }
  }

  private relative(repositoryPath: string): string {
    return this.volume.config.path ? repositoryPath.slice(this.volume.config.path.length + 1) : repositoryPath
  }

  private repositoryPath(name: string): string {
    return [this.volume.config.path, name].filter(Boolean).join('/')
  }

  private target(name: string): string { return path.join(this.local.config.path, name) }

  private bytes(name: string): Promise<Buffer | null> {
    return fs.readFile(this.target(name)).catch(error => { if (missing(error)) return null; throw error })
  }

  private current(name: string): string | null {
    const entry = own(this.edits.unpushed, name)
    return entry ? entry.sha : own(this.state.files, name)?.sha ?? null
  }

  /** Versions an agent wrote live in memory, like the served records that point at them. */
  private remember(bytes: Buffer): string {
    const sha = blobSha(bytes)
    this.written.set(sha, bytes)
    return sha
  }

  private async blob(sha: string | null | undefined): Promise<Buffer | null> {
    if (!sha) return null
    const written = this.written.get(sha)
    if (written) return written
    const fetched = await githubBlob(this.volume.config, sha)
    if (blobSha(fetched) !== sha) throw new VolumeError('GitHub blob content did not match its SHA.', 503)
    return fetched
  }

  private saveEdits(): Promise<void> {
    this.checkRemoved()
    return writeJsonFileAtomic(path.join(this.folder, 'edits.json'), githubEditsSchema.parse(this.edits))
  }

  private async save(state: SyncState): Promise<void> {
    this.checkRemoved()
    await saveSyncState(this.folder, state)
    this.state = state
  }

  private seen(mount: string): Map<string, (string | null)[]> {
    let map = this.served.get(mount)
    if (!map) { map = new Map(); this.served.set(mount, map) }
    return map
  }

  private sentBy(mount: string): Map<string, string> {
    let map = this.sent.get(mount)
    if (!map) { map = new Map(); this.sent.set(mount, map) }
    return map
  }

  private unsee(mount: string, name: string): void {
    this.seen(mount).delete(name)
    this.sentBy(mount).delete(name)
  }

  canonical(name: string): string {
    if (!this.caseInsensitive || own(this.state.files, name)) return name
    const key = name.normalize('NFC').toLowerCase()
    return Object.keys(this.state.files).find(tracked => tracked.normalize('NFC').toLowerCase() === key) ?? name
  }

  private async loadRules(): Promise<void> {
    for (const { sha } of this.edits.ignores) {
      if (!this.rules.has(sha)) this.rules.set(sha, (await this.blob(sha))?.toString('utf8') ?? '')
    }
  }

  /** Throws while a `.gitignore` above a subfolder drive is unread, so nothing it excludes can push. */
  private async ignored(name: string): Promise<boolean> {
    if (name.split('/').some(part => part.toLowerCase() === '.git')) return true
    if (own(this.state.files, name)) return false
    const sources = this.edits.ignores.map(({ dir, sha }) => {
      const text = this.rules.get(sha)
      if (text === undefined) throw new VolumeError('The repository’s .gitignore could not be read.', 503)
      return { dir, text }
    })
    const parts = name.split('/')
    for (let i = 0; i < parts.length; i++) {
      const text = (await this.bytes([...parts.slice(0, i), '.gitignore'].join('/')))?.toString('utf8')
      if (text) sources.push({ dir: this.repositoryPath(parts.slice(0, i).join('/')), text })
    }
    let ignored = false
    const full = this.repositoryPath(name)
    for (const { dir, text } of sources) {
      const result = ignore({ ignorecase: this.caseInsensitive }).add(text).test(dir ? full.slice(dir.length + 1) : full)
      if (result.ignored) ignored = true
      if (result.unignored) ignored = false
    }
    return ignored
  }

  /** Marks paths unpushed before their operation runs, bumping each counter, so a push never clears an edit it did not send. */
  private async mark(names: string[], agent: string, groupOf: (name: string) => string | undefined = () => undefined): Promise<boolean> {
    let marked = false
    for (const name of names) {
      if (await this.ignored(name).catch(() => false)) continue
      const previous = own(this.edits.unpushed, name)
      const group = groupOf(name) ?? previous?.group
      const old = previous?.group
      if (group && old && old !== group) {
        for (const entry of Object.values(this.edits.unpushed)) if (entry.group === old) entry.group = group
      }
      this.policyHeld.delete(name)
      this.edits.unpushed[name] = {
        agents: [...new Set([...previous?.agents ?? [], agent].filter(Boolean))], n: (previous?.n ?? 0) + 1,
        sha: previous ? previous.sha : own(this.state.files, name)?.sha ?? null, ...(group ? { group } : {}),
      }
      marked = true
    }
    if (marked) await this.saveEdits()
    return marked
  }

  async read(mount: string, requested: string): Promise<VolumeFile> {
    await this.ready()
    const name = this.canonical(requested)
    return serialize([this.key], async () => {
      const versions = this.seen(mount).get(name) ?? []
      const sha = this.current(name)
      if (sha && !this.written.has(sha) && own(this.edits.unpushed, name)?.sha === sha) {
        const bytes = await this.bytes(name)
        if (bytes && bytes.length <= GITHUB_PUSH_BYTES && blobSha(bytes) === sha) this.remember(bytes)
      }
      if (versions.at(-1) !== sha) this.seen(mount).set(name, versions.length ? [versions[0], sha] : [sha])
      this.sentBy(mount).delete(name)
      return this.local.read(requested)
    })
  }

  async write(mount: string, agent: string, requested: string, body: globalThis.ReadableStream<Uint8Array>, signal?: AbortSignal, group?: string): Promise<void> {
    await this.ready()
    const name = this.canonical(requested)
    await this.loadRules().catch(() => {})
    if (await this.ignored(name).catch(() => false)) return this.local.write(name, body)
    const chunks = uploadChunks(body, GITHUB_PUSH_BYTES + 1, signal)
    const first = await chunks.next()
    const upload = Buffer.from(first.done ? new ArrayBuffer(0) : first.value)
    if (upload.length > GITHUB_PUSH_BYTES) {
      // Too large to push: kept as written, and held at push time.
      let pending: Uint8Array | null = upload
      try {
        await serialize([this.key], () => { throwIfUploadAborted(signal); this.writing.add(name); return this.mark([name], agent, () => group) })
        await this.local.write(name, new globalThis.ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = pending ? { done: false, value: pending } : await chunks.next().then(chunk => chunk.done ? chunk : { done: false, value: new Uint8Array(chunk.value) })
          pending = null
          if (next.done) controller.close()
          else controller.enqueue(next.value)
        },
        cancel() { void chunks.return(undefined) },
        }))
        const sha = await fileBlobSha(this.target(name))
        await serialize([this.key], async () => {
          await this.resolve(name)
          await this.mark([name], agent, () => group)
          const entry = own(this.edits.unpushed, name)
          if (entry) entry.sha = sha
          this.unsee(mount, name)
          await this.saveEdits()
        })
      } finally { this.writing.delete(name) }
      return this.schedulePush()
    }
    await chunks.return(undefined)
    const sha = blobSha(upload)
    const versions = this.seen(mount).get(name) ?? []
    const base = versions[0] ?? this.sentBy(mount).get(name) ?? this.current(name)
    const fetched = new Map<string, Buffer | null>()
    const bytesOf = async (version: string | null | undefined) => {
      if (!version) return null
      if (!fetched.has(version)) fetched.set(version, await this.blob(version))
      return fetched.get(version)!
    }
    const needsMerge = () => !own(this.edits.held, name) && this.current(name) !== base && this.current(name) !== sha
    const held = own(this.edits.held, name)
    if (needsMerge()) await bytesOf(base)
    if (held && held.behind !== undefined) await Promise.all([bytesOf(own(this.state.files, name)?.sha), bytesOf(held.behind)])
    await serialize([this.key], async () => {
      throwIfUploadAborted(signal)
      // The same bytes again, with no read since: a replayed upload, already applied.
      if (!this.seen(mount).has(name) && this.sentBy(mount).get(name) === sha) return
      const hold = own(this.edits.held, name)
      let out: Buffer = upload
      let conflict: string | undefined
      const resolving = hold?.behind !== undefined
      if (resolving) {
        // A rewrite resolves the conflict, merged with what GitHub changed since the markers were made.
        const merged = mergePath(await bytesOf(own(this.state.files, name)?.sha), upload, await bytesOf(hold?.behind), this.state.base!)
        out = merged.content ?? upload
        conflict = merged.conflict
      } else if (needsMerge()) {
        const merged = mergePath(await bytesOf(base), upload, await this.bytes(name), this.state.base!)
        // GitHub deleted the file and the agent wrote back what it read: the delete stands.
        if (!merged.content) { this.seen(mount).delete(name); this.sentBy(mount).set(name, this.remember(upload)); return }
        out = merged.content
        conflict = merged.conflict
      }
      await this.mark([name], agent, () => group)
      await this.local.write(name, new Blob([new Uint8Array(out)]).stream())
      if (resolving) await this.resolve(name)
      const written = this.remember(out)
      const entry = own(this.edits.unpushed, name)
      if (entry) entry.sha = written
      if (conflict) this.edits.held[name] = { reason: conflict }
      else delete this.edits.held[name]
      this.seen(mount).delete(name)
      this.sentBy(mount).set(name, this.remember(upload))
      await this.saveEdits()
    })
    this.schedulePush()
  }

  /** A rewrite of a held path takes GitHub's newer version, recorded while it was held, as its base. */
  private async resolve(name: string): Promise<void> {
    const hold = own(this.edits.held, name)
    delete this.edits.held[name]
    if (hold?.behind === undefined) return
    const files = { ...this.state.files }
    if (hold.behind) files[name] = { sha: hold.behind, mode: own(files, name)?.mode ?? '100644' }
    else delete files[name]
    await this.save({ ...this.state, files })
  }

  async delete(mount: string, agent: string, requested: string, group?: string, expected?: string): Promise<void> {
    await this.ready()
    const name = this.canonical(requested)
    const hold = own(this.edits.held, name)
    const keep = hold ? (hold.behind !== undefined ? hold.behind : own(this.state.files, name)?.sha ?? null) : null
    const kept = await this.blob(keep)
    const marked = await serialize([this.key], async () => {
      if ((await this.local.stat(name)).kind === 'directory') { await this.local.delete(name); return false }
      // A move deletes its source only if no other write replaced it after the move read it.
      if (expected && (this.writing.has(name) || await fileBlobSha(this.target(name)) !== expected)) return false
      if (own(this.edits.held, name)) {
        // Deleting a conflicted file keeps GitHub's version and pushes nothing.
        const files = { ...this.state.files }
        if (kept) {
          await this.local.write(name, new Blob([new Uint8Array(kept)]).stream())
          files[name] = { sha: keep!, mode: own(files, name)?.mode ?? '100644' }
        } else {
          await this.local.delete(name)
          delete files[name]
        }
        await this.save({ ...this.state, files })
        delete this.edits.held[name]
        delete this.edits.unpushed[name]
        this.unsee(mount, name)
        await this.saveEdits()
        return false
      }
      const marked = await this.mark([name], agent, () => group)
      await this.local.delete(name)
      const entry = own(this.edits.unpushed, name)
      if (entry) entry.sha = null
      this.unsee(mount, name)
      if (marked) await this.saveEdits()
      return marked
    })
    if (marked) this.schedulePush()
  }

  async mkdir(name: string): Promise<void> {
    await this.ready()
    await serialize([this.key], () => this.local.mkdir(this.canonical(name)))
  }

  async move(mount: string, agent: string, requestedFrom: string, requestedTo: string): Promise<void> {
    await this.ready()
    const from = this.canonical(requestedFrom)
    const to = this.canonical(requestedTo)
    if (from === to) return
    const held = [from, to].find(name => own(this.edits.held, name))
    if (held) throw new WorkspaceFileError('not-accessible', `${held} has a conflict with GitHub. Resolve it before moving it.`)
    const source = await this.local.stat(from)
    if (own(this.state.files, to) && source.kind === 'file' && source.size <= GITHUB_PUSH_BYTES) {
      // A save by rename onto a tracked file merges like a write, so a pulled change to it survives.
      const bytes = await this.bytes(from)
      if (!bytes) throw new WorkspaceFileError('not-found')
      const group = randomUUID()
      await this.write(mount, agent, to, new Blob([new Uint8Array(bytes)]).stream(), undefined, group)
      return this.delete(mount, agent, from, group, blobSha(bytes))
    }
    const marked = await serialize([this.key], async () => {
      const root = this.target(from)
      const sources = (await this.local.stat(from)).kind === 'file' ? [from]
        : (await fs.readdir(root, { recursive: true, withFileTypes: true })).filter(entry => !entry.isDirectory())
          .map(entry => path.relative(this.local.config.path, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      const pairs = sources.map(source => [source, to + source.slice(from.length)] as const)
      const held = pairs.flat().find(name => own(this.edits.held, name))
      if (held) throw new WorkspaceFileError('not-accessible', `${held} has a conflict with GitHub. Resolve it before moving it.`)
      const shas = new Map(sources.map(source => [source, this.current(source)]))
      const groups = new Map(pairs.flatMap(pair => { const group = randomUUID(); return pair.map(name => [name, group] as const) }))
      const marked = await this.mark(pairs.flat(), agent, name => groups.get(name))
      await this.local.move(from, to)
      const seen = this.seen(mount)
      for (const [source, destination] of pairs) {
        const sha = shas.get(source) ?? await fileBlobSha(this.target(destination))
        const moved = own(this.edits.unpushed, source), landed = own(this.edits.unpushed, destination)
        if (moved) moved.sha = null
        if (landed) landed.sha = sha
        const versions = seen.get(source), sent = this.sentBy(mount).get(source)
        this.unsee(mount, source)
        this.unsee(mount, destination)
        if (versions) seen.set(destination, versions)
        else if (sent) this.sentBy(mount).set(destination, sent)
        else seen.set(destination, [sha])
      }
      await this.saveEdits()
      return marked
    })
    if (marked) this.schedulePush()
  }

  private async snapshot(oid: string): Promise<Record<string, GithubFile>> {
    this.clash = null
    const root = this.volume.config.path
    const all = await githubTree({ ...this.volume.config, path: '' }, oid)
    const parts = root ? root.split('/') : []
    // A subfolder drive also follows the `.gitignore` files of the folders above it.
    this.edits.ignores = parts.map((_, i) => parts.slice(0, i).join('/')).flatMap(dir => all
      .filter(entry => entry.type === 'blob' && entry.path === (dir ? `${dir}/.gitignore` : '.gitignore')).map(entry => ({ dir, sha: entry.sha })))
    const inside = all.filter(entry => !root || entry.path.startsWith(`${root}/`))
    this.edits.links = inside.filter(entry => entry.mode === '120000' || entry.type === 'commit').map(entry => this.relative(entry.path))
    const files = Object.fromEntries(inside.filter(entry => entry.type === 'blob' && entry.mode !== '120000')
      .map(entry => [this.relative(entry.path), { sha: entry.sha, mode: entry.mode }]))
    const collisions = snapshotCollisions(Object.keys(files), this.caseInsensitive).flat()
    if (collisions.length) {
      this.clash = `Paths collide on this disk: ${collisions.join(', ')}`
      throw new WorkspaceFileError('not-accessible', this.clash)
    }
    return files
  }

  private async archive(oid: string, files: Record<string, GithubFile>, destination: string): Promise<void> {
    this.checkRemoved()
    await fs.mkdir(destination, { recursive: true })
    const response = await githubTarball(this.volume.config, oid)
    this.checkRemoved()
    if (!(response.body instanceof ReadableStream)) throw new VolumeError('GitHub returned an empty archive.', 503)
    const root = this.volume.config.path
    const strip = 1 + (root ? root.split('/').length : 0)
    const extractor = tar.x({ cwd: destination, strip, strict: true, filter: (name, entry) => {
      if (this.removed) return false
      const repositoryPath = name.split('/').slice(1).join('/').replace(/\/$/, '')
      if (root && !repositoryPath.startsWith(`${root}/`)) return false
      const relative = this.relative(repositoryPath)
      return Object.hasOwn(files, relative) && 'type' in entry && entry.type === 'File'
    } })
    await pipeline(Readable.fromWeb(response.body), extractor)
    for (const [name, file] of Object.entries(files)) {
      const target = path.join(destination, name)
      const sha = await fileBlobSha(target).catch(error => {
        if (errnoCode(error) === 'ENOENT') return null
        throw error
      })
      if (sha !== file.sha) {
        const original = await githubBlob(this.volume.config, file.sha)
        if (blobSha(original) !== file.sha) throw new VolumeError('GitHub blob content did not match its SHA.', 503)
        this.checkRemoved()
        await fs.mkdir(path.dirname(target), { recursive: true })
        this.checkRemoved()
        await fs.writeFile(target, original, { mode: parseInt(file.mode, 8) })
      }
    }
  }

  private async stage(): Promise<void> {
    if (Object.keys(this.edits.unpushed).length || Object.keys(this.edits.held).length) {
      throw new VolumeError('The drive has changes that are not on GitHub, but its copy or sync state is missing.', 409)
    }
    this.prepared = false
    const oid = await githubHead(this.volume.config)
    const files = await this.snapshot(oid)
    try {
      this.checkRemoved()
      await fs.rm(this.local.config.path, { recursive: true, force: true })
      await this.archive(oid, files, this.local.config.path)
      if (this.removed) return
      await this.save({ ...this.state, base: oid, files })
      await this.saveEdits()
      this.prepared = true
    } catch (error) {
      if (!this.removed) await fs.rm(this.local.config.path, { recursive: true, force: true })
      throw error
    }
  }

  private async pull(head: string): Promise<void> {
    if (head === this.state.base) return
    const files = await this.snapshot(head)
    const changed = [...new Set([...Object.keys(this.state.files), ...Object.keys(files)])]
      .filter(name => own(this.state.files, name)?.sha !== own(files, name)?.sha || own(this.state.files, name)?.mode !== own(files, name)?.mode)
    const incoming = Object.fromEntries(changed.filter(name => Object.hasOwn(files, name)).map(name => [name, files[name]]))
    const stage = path.join(this.folder, 'pull')
    try {
      this.checkRemoved()
      await fs.rm(stage, { recursive: true, force: true })
      if (Object.keys(incoming).length) await this.archive(head, incoming, stage)
      const bases = new Map<string, Buffer | null>()
      for (const name of changed) {
        if (Object.hasOwn(this.edits.unpushed, name) && !own(this.edits.held, name)) bases.set(name, await this.blob(own(this.state.files, name)?.sha))
      }
      for (const name of Object.keys(incoming)) {
        if (own(this.state.files, name) || own(this.edits.held, name) || Object.hasOwn(this.edits.unpushed, name)) continue
        const local = await fileBlobSha(this.target(name)).catch(error => { if (missing(error)) return null; throw error })
        if (local && local !== incoming[name].sha) throw new VolumeError(`GitHub added a file the drive already has: ${name}`, 409)
      }
      if (this.removed) return
      await serialize([this.key], async () => {
        const next = { ...files }
        const removed: string[] = []
        for (const [name, hold] of Object.entries(this.edits.held)) {
          hold.behind = own(files, name)?.sha ?? null
          const tracked = own(this.state.files, name)
          if (tracked) next[name] = tracked
          else delete next[name]
        }
        const held = new Set(Object.keys(this.edits.held))
        try {
          for (const name of changed) {
            if (held.has(name)) continue
            if (Object.hasOwn(this.edits.unpushed, name)) {
              const local = await this.bytes(name)
              if (local) this.remember(local)
              const remote = own(files, name) ? await fs.readFile(path.join(stage, name)) : null
              const base = bases.has(name) ? bases.get(name)! : await this.blob(own(this.state.files, name)?.sha)
              const merged = mergePath(base, local, remote, head)
              if (merged.conflict) { this.edits.held[name] = { reason: merged.conflict }; await this.saveEdits() }
              if (!merged.content) {
                if (local) { await fs.unlink(this.target(name)); removed.push(name) }
              } else if (!local?.equals(merged.content)) {
                await fs.mkdir(path.dirname(this.target(name)), { recursive: true })
                await this.local.write(name, new Blob([new Uint8Array(merged.content)]).stream())
              }
              const sha = merged.content ? this.remember(merged.content) : null
              if (sha === (own(files, name)?.sha ?? null) && !merged.conflict && !this.writing.has(name)) delete this.edits.unpushed[name]
              else this.edits.unpushed[name].sha = sha
            } else if (own(this.state.files, name)?.mode !== own(files, name)?.mode) {
              const entry = await fs.lstat(this.target(name)).catch(error => { if (missing(error)) return null; throw error })
              if (entry && !entry.isDirectory()) { this.checkRemoved(); await fs.unlink(this.target(name)); removed.push(name) }
            }
          }
          const parents = new Set(removed.flatMap(name => name.split('/').slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join('/'))))
          for (const parent of [...parents].sort((a, b) => b.length - a.length)) {
            this.checkRemoved()
            await fs.rmdir(this.target(parent)).catch(error => {
              if (!['ENOENT', 'ENOTDIR', 'ENOTEMPTY'].includes(errnoCode(error) ?? '')) throw error
            })
          }
          for (const name of Object.keys(incoming)) {
            if (own(this.edits.held, name) || Object.hasOwn(this.edits.unpushed, name)) continue
            this.checkRemoved()
            // A local folder where GitHub now has a file, or the reverse, pauses the sync until one side moves.
            await fs.mkdir(path.dirname(this.target(name)), { recursive: true })
              .then(() => { this.checkRemoved(); return fs.rename(path.join(stage, name), this.target(name)) })
              .catch(error => {
                if (!['EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EEXIST'].includes(errnoCode(error) ?? '')) throw error
                throw new VolumeError(`GitHub has a file where the drive has a folder, or the reverse: ${name}`, 409)
              })
          }
          await this.save({ ...this.state, base: head, files: next })
        } finally { if (!this.removed) await this.saveEdits() }
      })
    } finally { if (!this.removed) await fs.rm(stage, { recursive: true, force: true }) }
  }

  private async push(): Promise<void> {
    let lost: unknown = null
    const slugs = [...new Set(Object.values(this.edits.unpushed).flatMap(entry => entry.agents))]
    // Imported here: the agent service loads the container runtime, which loads this module.
    const { getAgentRecord } = await import('@shared/lib/services/agent-service')
    const names = new Map(await Promise.all(slugs.map(async slug => [slug, (await getAgentRecord(slug).catch(() => null))?.name ?? slug] as const)))
    for (let attempt = 0; attempt < 3; attempt++) {
      lost = null
      if (this.edits.stopped || !this.state.base) return
      await this.loadRules()
      const entries = await serialize([this.key], async () => Object.entries(this.edits.unpushed).map(([name, entry]) => ({ name, ...entry })))
      const heldGroups = new Set(Object.keys(this.edits.held).map(name => own(this.edits.unpushed, name)?.group).filter(Boolean))
      const changes: PushChange[] = []
      const settled: typeof entries = []
      for (const entry of entries) {
        const change = { path: this.repositoryPath(entry.name), contents: null, mode: own(this.state.files, entry.name)?.mode ?? '100644', group: entry.group }
        const hold = own(this.edits.held, entry.name)?.reason ?? (entry.group && heldGroups.has(entry.group) ? 'moved with a held file'
          : this.edits.links.includes(entry.name) ? 'a link or submodule on GitHub' : this.writing.has(entry.name) ? 'still uploading' : undefined)
        if (hold) { changes.push({ ...change, held: hold }); continue }
        if (await this.ignored(entry.name)) { settled.push(entry); continue }
        if (((await fs.lstat(this.target(entry.name)).catch(() => null))?.size ?? 0) > GITHUB_PUSH_BYTES) {
          changes.push({ ...change, held: 'over the size limit' })
          continue
        }
        const contents = await this.bytes(entry.name)
        if ((contents && blobSha(contents)) === (own(this.state.files, entry.name)?.sha ?? null)) { settled.push(entry); continue }
        changes.push({ ...change, contents })
      }
      const plan = planPush(changes)
      this.policyHeld = new Map([...plan.held].map(([repositoryPath, reason]) => [this.relative(repositoryPath), reason]))
      await serialize([this.key], async () => {
        for (const entry of settled) if (own(this.edits.unpushed, entry.name)?.n === entry.n) delete this.edits.unpushed[entry.name]
        await this.saveEdits()
      })
      const counters = new Map(entries.map(entry => [entry.name, entry.n]))
      const agents = new Map(entries.map(entry => [entry.name, entry.agents]))
      const batches = plan.batches
      let stale = false
      for (const batch of batches) {
        const base = this.state.base!
        const paths = batch.map(change => this.relative(change.path))
        const by = [...new Set(paths.flatMap(name => agents.get(name) ?? []))].map(slug => names.get(slug) ?? slug).join(', ') || 'an agent'
        let oid: string
        try {
          oid = await githubCommit(this.volume.config, base, batch, `Update ${paths.length === 1 ? paths[0] : `${paths.length} files`} from ${by}`)
        } catch (error) {
          const head = await githubHead(this.volume.config)
          if (head !== base || !(error instanceof WorkspaceFileError)) {
            if (head === base) lost = error
            stale = true
            break
          }
          this.edits.stopped = error.message
          await this.saveEdits()
          return
        }
        await serialize([this.key], async () => {
          const files = { ...this.state.files }
          for (const change of batch) {
            const name = this.relative(change.path)
            const sha = change.contents && blobSha(change.contents)
            if (sha) files[name] = { sha, mode: change.mode }
            else delete files[name]
            if (own(this.edits.unpushed, name)?.n === counters.get(name) && !this.writing.has(name)) delete this.edits.unpushed[name]
          }
          await this.save({ ...this.state, base: oid, files })
          await this.saveEdits()
        })
      }
      this.forget()
      if (!stale) {
        if (batches.flat().some(change => Object.hasOwn(this.edits.unpushed, this.relative(change.path)))) this.schedulePush()
        return
      }
      await this.pull(await githubHead(this.volume.config))
    }
    if (lost) throw lost
    this.schedulePush()
  }

  private forget(): void {
    const keep = new Set([...this.served.values()].flatMap(paths => [...paths.values()].flat())
      .concat([...this.sent.values()].flatMap(paths => [...paths.values()]), Object.values(this.edits.unpushed).map(entry => entry.sha)))
    for (const sha of this.written.keys()) if (!keep.has(sha)) this.written.delete(sha)
  }

  remove(): void {
    this.removed = true
    if (this.timer) clearTimeout(this.timer)
  }
}

export function githubSync(volume: GithubVolume): GithubSync {
  let sync = syncs.get(volume.id)
  if (!sync) { sync = new GithubSync(volume); syncs.set(volume.id, sync) }
  return sync
}

export async function removeGithubSync(id: string): Promise<void> {
  syncs.get(id)?.remove()
  syncs.delete(id)
  await removeCopy(id)
}

async function removeCopy(id: string): Promise<void> {
  await fs.rm(volumeFolder(id), { recursive: true, force: true })
    .catch(error => { console.warn(`[volumes] Cannot remove GitHub copy ${id}:`, error) })
}
