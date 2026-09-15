/**
 * A local copy of a remote agent's transcripts, brought up to date before
 * they are read.
 *
 * The Claude CLI writes each session's transcript, and the files beside it
 * (subagent and workflow transcripts), under `.claude/projects/<project>` in
 * the workspace, where `<project>` is the working directory's real path with
 * its slashes turned into dashes. For a local agent that is `-workspace` and
 * the session service reads it in place. In a Modal sandbox `/workspace` is
 * a link to the volume's mount point, so the CLI names the project after
 * that (`---modal-volumes-vo-…`); the workspace is the only project there
 * is, so this mirror takes every project directory on the volume as the one
 * the session service reads from the host path, downloading only what
 * changed since the last pass (one listing RPC when nothing did) and
 * removing copies of files that are gone from the volume.
 *
 * The copy is a cache of the volume, not a second authority: a transcript
 * edit made on this machine (removing a message, appending an informational
 * entry) is not pushed back and is lost when the volume's copy next changes.
 * Reading transcripts from the volume directly is the real fix; this is the
 * spike's bridge to it.
 */
import fs from 'fs'
import path from 'path'
import { getAgentSessionsDir, writeFileAtomicStream } from '@shared/lib/utils/file-storage'
import { ModalVolumeError, type ModalVolumeFiles, type VolumeEntry } from '@shared/lib/container/modal/modal-volume'
import { joinWorkspacePath } from './workspace-path'

/** Where the CLI keeps one directory per project, relative to the workspace root. */
export const PROJECTS_DIR = '.claude/projects'

/** A pass that finished this recently is not repeated: the UI fires several reads at once. */
const MIN_INTERVAL_MS = 750
const DOWNLOAD_CONCURRENCY = 4

interface Mirrored {
  size: number
  mtimeMs: number
}

/** A transcript file on the volume: which project directory it is in, and its path within it. */
interface RemoteTranscript {
  project: string
  rel: string
  entry: VolumeEntry
}

function splitProjectPath(volumePath: string): { project: string; rel: string } | null {
  if (!volumePath.startsWith(`${PROJECTS_DIR}/`)) return null
  const inside = volumePath.slice(PROJECTS_DIR.length + 1)
  const slash = inside.indexOf('/')
  if (slash === -1) return null
  return { project: inside.slice(0, slash), rel: inside.slice(slash + 1) }
}

export class TranscriptMirror {
  /** Remote files already copied, by path relative to the project directory. */
  private readonly mirrored = new Map<string, Mirrored>()
  /** The project directories seen on the last pass, for removals. */
  private projects = new Set<string>()
  private inFlight: Promise<void> | null = null
  private lastSyncedAt = 0

  constructor(
    private readonly slug: string,
    private readonly volume: () => Promise<ModalVolumeFiles>,
    private readonly localDir: () => string = () => getAgentSessionsDir(slug),
  ) {}

  /** Bring the local copy up to date. Concurrent callers share one pass. */
  sync(): Promise<void> {
    if (this.inFlight) return this.inFlight
    if (Date.now() - this.lastSyncedAt < MIN_INTERVAL_MS) return Promise.resolve()
    this.inFlight = this.pass().finally(() => {
      this.inFlight = null
      this.lastSyncedAt = Date.now()
    })
    return this.inFlight
  }

  private async pass(): Promise<void> {
    const volume = await this.volume()
    let entries: VolumeEntry[]
    try {
      entries = await volume.list(PROJECTS_DIR, true)
    } catch (error) {
      // No transcript has been written yet.
      if (error instanceof ModalVolumeError && error.code === 'not-found') entries = []
      else throw error
    }
    const remote = new Map<string, RemoteTranscript>()
    const projects = new Set<string>()
    for (const entry of entries) {
      if (entry.kind !== 'file') continue
      const split = splitProjectPath(entry.path)
      if (!split) continue
      projects.add(split.project)
      remote.set(split.rel, { ...split, entry })
    }
    this.projects = projects

    const changed = [...remote.values()].filter(({ rel, entry }) => {
      const known = this.mirrored.get(rel)
      return !known || known.size !== entry.size || known.mtimeMs !== entry.mtimeMs
    })
    const queue = [...changed]
    const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        await this.download(volume, item)
      }
    })
    await Promise.all(workers)

    for (const rel of [...this.mirrored.keys()]) {
      if (remote.has(rel)) continue
      await fs.promises.rm(this.localPath(rel), { force: true })
      this.mirrored.delete(rel)
    }
  }

  private localPath(rel: string): string {
    return path.join(this.localDir(), ...rel.split('/'))
  }

  private async download(volume: ModalVolumeFiles, { rel, entry }: RemoteTranscript): Promise<void> {
    const localPath = this.localPath(rel)
    if (!this.mirrored.has(rel)) {
      // First sight of this file since this process started: the copy from a
      // previous run may already be current.
      const stat = await fs.promises.stat(localPath).catch(() => null)
      if (stat?.isFile() && stat.size === entry.size && stat.mtimeMs >= entry.mtimeMs) {
        this.mirrored.set(rel, { size: entry.size, mtimeMs: entry.mtimeMs })
        return
      }
    }
    const bytes = await volume.read(entry.path)
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true })
    await writeFileAtomicStream(localPath, [Buffer.from(bytes)], { fsync: false })
    this.mirrored.set(rel, { size: entry.size, mtimeMs: entry.mtimeMs })
  }

  /**
   * Remove a session's transcript and the files beside it from the volume,
   * after the session service removed the local copies. Nothing there is fine.
   */
  async removeSession(sessionId: string): Promise<void> {
    const volume = await this.volume()
    for (const project of this.projects) {
      const targets: Array<[string, boolean]> = [
        [joinWorkspacePath(PROJECTS_DIR, project, `${sessionId}.jsonl`), false],
        [joinWorkspacePath(PROJECTS_DIR, project, sessionId), true],
      ]
      for (const [remotePath, recursive] of targets) {
        try {
          await volume.remove(remotePath, recursive)
        } catch (error) {
          if (!(error instanceof ModalVolumeError && error.code === 'not-found')) throw error
        }
      }
    }
    for (const rel of [...this.mirrored.keys()]) {
      if (rel === `${sessionId}.jsonl` || rel.startsWith(`${sessionId}/`)) this.mirrored.delete(rel)
    }
  }
}
