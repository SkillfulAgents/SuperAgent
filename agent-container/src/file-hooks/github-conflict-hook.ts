import { z } from 'zod'
import { FileHook, type FileHookReadResult, type FileHookWriteResult } from './file-hook'

/** The label a GitHub drive writes under each conflict; a file containing it never syncs. */
const CONFLICT_LABEL = />>>>>>> GitHub [0-9a-f]{7,40} \(/
const HINT = 'This file has unresolved conflict markers from a GitHub drive: a teammate changed the same lines on GitHub. ' +
  'It will not sync until they are gone. Resolve it now: keep what each side meant, then remove every marker line. ' +
  'If resolving it is outside what you were asked to do, tell the user this file has a conflict.'

const readResponseSchema = z.object({ file: z.object({ content: z.string() }) })

/** Checks the text the agent already has, so no tool call costs an extra read. */
export class GithubConflictFileHook extends FileHook {
  pattern(): string {
    return '/mounts/*/**'
  }

  matches(filePath: string): boolean {
    return filePath.startsWith('/mounts/')
  }

  onRead(_filePath: string, response?: unknown): FileHookReadResult {
    const read = readResponseSchema.safeParse(response)
    return read.success && CONFLICT_LABEL.test(read.data.file.content) ? { additionalContext: HINT } : {}
  }

  onWrite(_filePath: string, content: string): FileHookWriteResult {
    return CONFLICT_LABEL.test(content) ? { warning: HINT } : {}
  }

  onEdit(_filePath: string, contentAfterEdit: string): FileHookWriteResult {
    return CONFLICT_LABEL.test(contentAfterEdit) ? { warning: HINT } : {}
  }
}
