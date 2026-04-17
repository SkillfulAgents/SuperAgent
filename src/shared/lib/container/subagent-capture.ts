import * as path from 'path'
import { promises as fsPromises } from 'fs'
import type { StreamMessage } from './types'

// Dev-only capture of MessagePersister inputs, outputs, and FS snapshots.
// Enabled when SUPERAGENT_CAPTURE_DIR is set. Used to produce realistic
// fixtures for the subagent-routing replay harness.

export class SubagentCapture {
  private readonly baseDir: string
  private readonly startedAt = Date.now()
  private snapshotCounter = 0

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

  // Snapshot the subagents directory (with mtimes preserved) at a labelled checkpoint.
  async snapshotSubagentsDir(sessionId: string, sourceDir: string, label: string): Promise<void> {
    const idx = String(this.snapshotCounter++).padStart(3, '0')
    const dest = path.join(this.sessionDir(sessionId), `snapshot-${idx}-${label}`)

    try {
      const files = await fsPromises.readdir(sourceDir)
      await fsPromises.mkdir(dest, { recursive: true })
      for (const file of files) {
        const srcPath = path.join(sourceDir, file)
        const destPath = path.join(dest, file)
        const stat = await fsPromises.stat(srcPath)
        if (!stat.isFile()) continue
        await fsPromises.copyFile(srcPath, destPath)
        await fsPromises.utimes(destPath, stat.atime, stat.mtime)
      }
      await this.recordNote(sessionId, 'fs_snapshot', { label, dir: `snapshot-${idx}-${label}`, fileCount: files.length })
    } catch (err) {
      await this.recordNote(sessionId, 'fs_snapshot_error', { label, error: String(err) })
    }
  }

  private async append(sessionId: string, fileName: string, data: unknown): Promise<void> {
    try {
      const dir = this.sessionDir(sessionId)
      await fsPromises.mkdir(dir, { recursive: true })
      await fsPromises.appendFile(path.join(dir, fileName), JSON.stringify(data) + '\n')
    } catch {
      // Capture is best-effort — never disrupt real flow.
    }
  }
}
