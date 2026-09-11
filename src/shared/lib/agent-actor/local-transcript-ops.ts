/**
 * Transcript-adjacent reads for an agent whose sessions live on this machine:
 * subagent and workflow transcripts beside the session's own, the raw
 * transcript bytes, media referenced from it, and the copy a fork makes.
 *
 * These are the places that used to build a transcript path themselves.
 * Every function here takes the slug; the actor binds it.
 */
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { z } from 'zod'
import { copyDirectoryFiltered, getAgentSessionsDir, getSessionJsonlPath, readJsonlFile, streamJsonlFile } from '@shared/lib/utils/file-storage'
import { isPathWithinDir } from '@shared/lib/utils/path-safety'
import { openMediaBlob, type MediaRef } from '@shared/lib/services/session-media'
import { buildWorkflowTree } from '@shared/lib/workflows/workflow-tree'
import type { WorkflowTree } from '@shared/lib/workflows/workflow-schemas'
import type { JsonlEntry } from '@shared/lib/types/agent'
import { captureException } from '@shared/lib/error-reporting'
import type { MediaBlob, SubagentRef } from './types'
import { WorkspaceFileError } from './workspace-path'

const SUBAGENT_ID = /^[\w-]+$/
const WORKFLOW_RUN_ID = /^wf_[\w-]+$/

/** The sidecar the container writes beside each subagent transcript. */
const subagentMetaSchema = z.object({ toolUseId: z.string().optional() }).loose()

/** A transcript-relative path that stays inside the agent's sessions directory. */
function sessionFile(slug: string, ...segments: string[]): string {
  const sessionsDir = getAgentSessionsDir(slug)
  const target = path.join(sessionsDir, ...segments)
  if (!isPathWithinDir(sessionsDir, target)) throw new WorkspaceFileError('invalid-path')
  return target
}

export async function listSubagents(slug: string, sessionId: string): Promise<SubagentRef[]> {
  const subagentsDir = sessionFile(slug, sessionId, 'subagents')
  let files: string[]
  try {
    files = await fs.promises.readdir(subagentsDir)
  } catch {
    return [] // No subagents directory
  }
  const refs: SubagentRef[] = []
  for (const file of files) {
    if (!file.startsWith('agent-') || !file.endsWith('.meta.json')) continue
    const id = file.slice('agent-'.length, -'.meta.json'.length)
    try {
      const raw = await fs.promises.readFile(path.join(subagentsDir, file), 'utf8')
      const meta = subagentMetaSchema.parse(JSON.parse(raw))
      refs.push(meta.toolUseId ? { id, toolUseId: meta.toolUseId } : { id })
    } catch {
      refs.push({ id }) // an unreadable sidecar still names a subagent
    }
  }
  return refs
}

export async function readSubagentTranscript(slug: string, sessionId: string, subagentId: string): Promise<JsonlEntry[]> {
  if (!SUBAGENT_ID.test(subagentId)) throw new WorkspaceFileError('invalid-path')
  const jsonlPath = sessionFile(slug, sessionId, 'subagents', `agent-${subagentId}.jsonl`)
  return readJsonlFile<JsonlEntry>(jsonlPath)
}

export async function readWorkflowTree(slug: string, sessionId: string, runId: string): Promise<WorkflowTree | null> {
  if (!WORKFLOW_RUN_ID.test(runId)) throw new WorkspaceFileError('invalid-path')
  // The tree builder resolves its own paths below the sessions directory; the
  // session id is checked here the same way every other read checks it.
  sessionFile(slug, sessionId)
  return buildWorkflowTree({ sessionsDir: getAgentSessionsDir(slug), sessionId, runId })
}

export async function readWorkflowAgentTranscript(
  slug: string,
  sessionId: string,
  runId: string,
  workflowAgentId: string,
): Promise<JsonlEntry[]> {
  if (!WORKFLOW_RUN_ID.test(runId) || !SUBAGENT_ID.test(workflowAgentId)) throw new WorkspaceFileError('invalid-path')
  const jsonlPath = sessionFile(slug, sessionId, 'subagents', 'workflows', runId, `agent-${workflowAgentId}.jsonl`)
  return readJsonlFile<JsonlEntry>(jsonlPath)
}

/** Copy a session's derived files (subagents, workflows) to a new session id. Nothing to copy is a no-op. */
export async function copyDerivedSessionFiles(slug: string, sourceSessionId: string, targetSessionId: string): Promise<void> {
  const source = sessionFile(slug, sourceSessionId)
  const target = sessionFile(slug, targetSessionId)
  try {
    await copyDirectoryFiltered(source, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

export function streamRawEntries(slug: string, sessionId: string): AsyncIterable<unknown> {
  return streamJsonlFile(getSessionJsonlPath(slug, sessionId))
}

function isBenignStreamError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ABORT_ERR' || code === 'ERR_STREAM_PREMATURE_CLOSE'
}

/**
 * The transcript's bytes, bounded to its size at open so the byte count always
 * matches what is streamed even while the agent appends. Null when there is
 * no transcript file.
 */
export async function openRawLog(slug: string, sessionId: string): Promise<{ size: number; stream: ReadableStream<Uint8Array> } | null> {
  const jsonlPath = getSessionJsonlPath(slug, sessionId)
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(jsonlPath, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw error
  }
  let size: number
  try {
    size = (await handle.stat()).size
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
  if (size === 0) {
    await handle.close().catch(() => {})
    return { size: 0, stream: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }) }
  }
  const source = handle.createReadStream({ end: size - 1 })
  source.on('error', (error) => {
    // A client hanging up mid-download is the normal case, not a fault to report.
    if (isBenignStreamError(error)) return
    console.error('Failed to stream raw log:', error)
    captureException(error, { tags: { component: 'agent-actor', operation: 'stream-raw-log' } })
  })
  return { size, stream: Readable.toWeb(source) as ReadableStream<Uint8Array> }
}

export async function openMedia(slug: string, sessionId: string, ref: MediaRef, signal?: AbortSignal): Promise<MediaBlob | undefined> {
  const blob = await openMediaBlob(getSessionJsonlPath(slug, sessionId), ref, signal)
  if (!blob) return undefined
  return { stream: Readable.toWeb(blob.stream) as ReadableStream<Uint8Array>, mimeType: blob.mimeType, bytes: blob.bytes }
}
