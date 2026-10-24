import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ReadableStream } from 'node:stream/web'
import * as tar from 'tar'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { errnoCode } from '@shared/lib/agent-actor/local-file-ops'
import { LocalMountableVolume } from './local-mountable-volume'
import { VolumeError, VolumePreparingError } from './volume-error'
import { githubBlob, githubHead, githubTarball, githubTree } from './github-client'
import type { GithubFile, GithubVolumeConfig, SyncState } from './github-schema'
import { blobSha, emptySyncState, loadSyncState, saveSyncState, snapshotCollisions, fileBlobSha, volumeFolder } from './github-sync-state'

const syncs = new Map<string, GithubSync>()
/** A read never shows the branch older than this, as Google Drive's listing cache allows. */
const FRESH_MS = 30_000
/** How long a stale read waits for the check before serving the copy. The proxy can hold a request while an account reconnects. */
const FRESH_WAIT_MS = 5_000
type GithubVolume = { id: string; name: string; config: GithubVolumeConfig }

export class GithubSync {
  readonly folder: string
  private localVolume: LocalMountableVolume | null = null
  state = emptySyncState()
  private loading: Promise<void> | null = null
  private prepared = false
  private caseInsensitive = false
  private syncing: Promise<void> | null = null
  private checkedAt = 0
  private waitUntil = 0
  private removed = false
  private failure: string | null = null
  private clash: string | null = null

  constructor(readonly volume: GithubVolume) {
    this.folder = volumeFolder(volume.id)
  }

  get local(): LocalMountableVolume {
    if (!this.localVolume) throw new VolumePreparingError()
    return this.localVolume
  }

  get loaded(): Promise<void> {
    return this.loading ??= this.load().catch(error => { this.loading = null; throw error })
  }
  get isReady(): boolean { return this.prepared }

  private checkRemoved(): void {
    if (this.removed) throw new WorkspaceFileError('not-found')
  }

  private async load(): Promise<void> {
    this.checkRemoved()
    await fs.rm(path.join(this.folder, 'pull'), { recursive: true, force: true })
    this.state = await loadSyncState(this.folder)
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
    if (this.removed || this.syncing || this.checkedAt > Date.now() - FRESH_MS) return
    void this.run()
  }

  /** Before a read: a copy checked over 30 s ago waits for the check. Every read waiting on one check shares its 5 s. */
  async fresh(): Promise<void> {
    if (this.removed) return
    await this.loaded.catch(() => {})
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

  async run(): Promise<void> {
    if (this.removed) return
    if (this.syncing) return this.syncing
    this.syncing = (async () => {
      try {
        this.checkedAt = Date.now()
        await this.loaded
        if (!this.prepared || this.state.base === null) await this.stage()
        else await this.pull()
        this.failure = null
      } catch (error) {
        if (this.removed) return
        this.failure = error instanceof VolumeError || error instanceof WorkspaceFileError ? error.message : 'GitHub copy failed'
        console.warn(`[volumes] GitHub sync ${this.volume.id}: ${this.failure}`)
      } finally {
        if (this.removed) await removeCopy(this.volume.id)
      }
    })().finally(() => { this.syncing = null })
    await this.syncing
  }

  private relative(repositoryPath: string): string {
    return this.volume.config.path ? repositoryPath.slice(this.volume.config.path.length + 1) : repositoryPath
  }

  private async snapshot(oid: string): Promise<Record<string, GithubFile>> {
    this.clash = null
    const entries = await githubTree(this.volume.config, oid)
    const files = Object.fromEntries(entries.filter(entry => entry.type === 'blob' && entry.mode !== '120000')
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

  private async save(state: SyncState): Promise<void> {
    this.checkRemoved()
    await saveSyncState(this.folder, state)
    this.state = state
  }

  private async stage(): Promise<void> {
    this.prepared = false
    const oid = await githubHead(this.volume.config)
    const files = await this.snapshot(oid)
    try {
      this.checkRemoved()
      await fs.rm(this.local.config.path, { recursive: true, force: true })
      await this.archive(oid, files, this.local.config.path)
      if (this.removed) return
      await this.save({ ...this.state, base: oid, files })
      this.prepared = true
    } catch (error) {
      if (!this.removed) await fs.rm(this.local.config.path, { recursive: true, force: true })
      throw error
    }
  }

  private async pull(): Promise<void> {
    const oid = await githubHead(this.volume.config)
    if (oid === this.state.base) return
    const files = await this.snapshot(oid)
    const changed = [...new Set([...Object.keys(this.state.files), ...Object.keys(files)])]
      .filter(name => this.state.files[name]?.sha !== files[name]?.sha || this.state.files[name]?.mode !== files[name]?.mode)
    const incoming = Object.fromEntries(changed.filter(name => Object.hasOwn(files, name)).map(name => [name, files[name]]))
    const stage = path.join(this.folder, 'pull')
    try {
      this.checkRemoved()
      await fs.rm(stage, { recursive: true, force: true })
      if (Object.keys(incoming).length) await this.archive(oid, incoming, stage)
      if (this.removed) return
      const removed = changed.filter(name => Object.hasOwn(this.state.files, name) && (!Object.hasOwn(files, name) || this.state.files[name].mode !== files[name].mode))
      for (const name of removed) {
        const target = path.join(this.local.config.path, name)
        const entry = await fs.lstat(target).catch(error => {
          if (['ENOENT', 'ENOTDIR'].includes(errnoCode(error) ?? '')) return null
          throw error
        })
        if (entry && !entry.isDirectory()) {
          this.checkRemoved()
          await fs.unlink(target)
        }
      }
      const parents = new Set(removed.flatMap(name => name.split('/').slice(0, -1).map((_, i) => name.split('/').slice(0, i + 1).join('/'))))
      for (const parent of [...parents].sort((a, b) => b.length - a.length)) {
        this.checkRemoved()
        await fs.rmdir(path.join(this.local.config.path, parent)).catch(error => {
          if (!['ENOENT', 'ENOTDIR', 'ENOTEMPTY'].includes(errnoCode(error) ?? '')) throw error
        })
      }
      for (const name of Object.keys(incoming)) {
        const target = path.join(this.local.config.path, name)
        this.checkRemoved()
        await fs.mkdir(path.dirname(target), { recursive: true })
        this.checkRemoved()
        await fs.rename(path.join(stage, name), target)
      }
      await this.save({ ...this.state, base: oid, files })
    } finally { if (!this.removed) await fs.rm(stage, { recursive: true, force: true }) }
  }

  remove(): void {
    this.removed = true
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
