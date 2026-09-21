/**
 * Where one agent's sessions are kept.
 *
 * Transcripts are files the CLI writes inside the agent's workspace, so
 * everything that reads or edits them — the session service, the transcript
 * appends, the media and workflow readers, the usage loaders — works on a
 * `SessionStore`: the workspace file operations, the configuration documents,
 * and the directory the CLI writes transcripts to. A local actor and a remote
 * one differ only in the `FileOps` they hold; the transcript code is the same.
 *
 * The transcripts directory is the store's to know. The CLI names its project
 * directory after the real path of its working directory (`-workspace` when
 * the workspace is mounted at `/workspace`), so a runtime that mounts it
 * elsewhere answers with a different directory, and nothing else spells it.
 */
import type { SessionSummaryCache } from '@shared/lib/services/session-summary-slot'
import type { AgentSlug, ConfigOps, FileOps } from './types'
import { WorkspaceFileError, joinWorkspacePath } from './workspace-path'

/**
 * Where the CLI writes transcripts when its working directory is
 * `/workspace`: the project directory is named after that path.
 */
export const CLI_TRANSCRIPTS_DIR = '.claude/projects/-workspace'

export interface SessionStore {
  readonly slug: AgentSlug
  /** The agent's workspace. */
  readonly files: FileOps
  /** The agent's configuration documents, session metadata among them. */
  readonly config: ConfigOps
  /** Workspace path of the directory the CLI writes transcripts to. */
  readonly transcriptsDir: string
  /**
   * Identifies the storage behind `files`, so that state cached per workspace
   * (the session summary) is shared by two stores over the same storage and
   * never by two over different ones. For a workspace on this machine it is
   * the workspace directory.
   */
  readonly key: string
  /**
   * The store's warm session summary (see `session-summary-cache`): built
   * from the transcripts directory on first read and kept current by the
   * writes recorded through the store. It is the store's, so it lives and
   * dies with the agent's actor and is never shared with another agent's
   * store, and it follows `key`: a store whose storage moved starts fresh.
   */
  readonly summaryCache: SessionSummaryCache
  /**
   * Told the epoch ms of every activity recorded against a session of this
   * store — a message sent to it, a frame received from it, a transcript
   * write. The local actor keeps its container's idle clock from it; a store
   * with no owner to tell leaves it unset.
   */
  readonly onActivity?: (activityAtMs: number) => void
}

/**
 * A session id names one transcript file directly inside the transcripts
 * directory: one path segment, nothing that climbs. Path shape only, not
 * existence: the callers that need "is this really a session" check that
 * on top.
 */
export function isSessionIdWellFormed(sessionId: string): boolean {
  return (
    typeof sessionId === 'string' &&
    sessionId !== '' &&
    sessionId !== '.' &&
    sessionId !== '..' &&
    !/[/\\\0]/.test(sessionId)
  )
}

function assertSessionId(sessionId: string): void {
  if (!isSessionIdWellFormed(sessionId)) throw new WorkspaceFileError('invalid-path', 'Invalid session ID')
}

/** Workspace path of a session's transcript. Throws `invalid-path` for an id that is not one segment. */
export function transcriptPath(store: SessionStore, sessionId: string): string {
  assertSessionId(sessionId)
  return joinWorkspacePath(store.transcriptsDir, `${sessionId}.jsonl`)
}

/** Workspace path of the directory beside a session's transcript, where its derived files live. */
export function sessionDirPath(store: SessionStore, sessionId: string): string {
  assertSessionId(sessionId)
  return joinWorkspacePath(store.transcriptsDir, sessionId)
}

/**
 * A path below a session's directory. The segments are unvalidated (URL
 * parts, file names from a listing), so one that would leave the directory
 * is refused lexically.
 */
export function sessionFilePath(store: SessionStore, sessionId: string, ...segments: string[]): string {
  const base = sessionDirPath(store, sessionId)
  const target = joinWorkspacePath(base, ...segments)
  if (target !== base && !target.startsWith(`${base}/`)) throw new WorkspaceFileError('invalid-path')
  return target
}
