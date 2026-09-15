import * as path from 'path'
import { promises as fsPromises } from 'fs'
import type { FileOps } from '@shared/lib/agent-actor/types'
import type { StreamMessage } from './types'

// Dev-only capture of MessagePersister inputs, outputs, and FS snapshots.
// Enabled when SUPERAGENT_CAPTURE_DIR is set. Used to produce realistic
// fixtures for the subagent-routing replay harness.

export class SubagentCapture {
  private readonly baseDir: string
  private readonly startedAt = Date.now()
  private snapshotCounter = 0
  // Serializes appends per file. Callers fire-and-forget recordInput/recordOutput,
  // so without this two near-simultaneous messages can land in the file in the
  // wrong order (the fixture line order then disagrees with processing order,
  // which the `t` field — stamped synchronously at call time — preserves).
  private writeChains = new Map<string, Promise<void>>()

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  static fromEnv(): SubagentCapture | null {
    const dir = process.env.SUPERAGENT_CAPTURE_DIR
    if (!dir) return null
    return new SubagentCapture(dir)
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.baseDir, sessionId)
  }

  async recordInput(sessionId: string, message: StreamMessage): Promise<void> {
    await this.append(sessionId, 'stream-input.jsonl', {
      t: Date.now() - this.startedAt,
      message,
    })
  }

  async recordOutput(sessionId: string, event: unknown): Promise<void> {
    await this.append(sessionId, 'sse-output.jsonl', {
      t: Date.now() - this.startedAt,
      event,
    })
  }

  async recordNote(sessionId: string, note: string, extra?: Record<string, unknown>): Promise<void> {
    await this.append(sessionId, 'notes.jsonl', {
      t: Date.now() - this.startedAt,
      note,
      ...extra,
    })
  }

  // Snapshot the subagents directory of the agent's workspace (with mtimes
  // preserved) at a labelled checkpoint. `sourceDir` is a workspace path.
  async snapshotSubagentsDir(sessionId: string, files: FileOps, sourceDir: string, label: string): Promise<void> {
    const idx = String(this.snapshotCounter++).padStart(3, '0')
    const dest = path.join(this.sessionDir(sessionId), `snapshot-${idx}-${label}`)

    try {
      const entries = await files.list(sourceDir)
      await fsPromises.mkdir(dest, { recursive: true })
      for (const entry of entries) {
        if (entry.kind !== 'file') continue
        const stat = await files.stat(entry.path)
        if (!stat) continue
        const destPath = path.join(dest, entry.name)
        const bytes = await files.getDoc(entry.path)
        if (bytes === null) continue
        await fsPromises.writeFile(destPath, bytes)
        const mtime = new Date(stat.mtimeMs)
        await fsPromises.utimes(destPath, mtime, mtime)
      }
      await this.recordNote(sessionId, 'fs_snapshot', { label, dir: `snapshot-${idx}-${label}`, fileCount: entries.length })
    } catch (err) {
      await this.recordNote(sessionId, 'fs_snapshot_error', { label, error: String(err) })
    }
  }

  private append(sessionId: string, fileName: string, data: unknown): Promise<void> {
    const key = `${sessionId}/${fileName}`
    const line = JSON.stringify(data) + '\n'
    const chained = (this.writeChains.get(key) ?? Promise.resolve()).then(async () => {
      try {
        const dir = this.sessionDir(sessionId)
        await fsPromises.mkdir(dir, { recursive: true })
        await fsPromises.appendFile(path.join(dir, fileName), line)
      } catch {
        // Capture is best-effort — never disrupt real flow.
      }
    })
    this.writeChains.set(key, chained)
    return chained
  }
}
