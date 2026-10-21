import * as path from 'path'
import { z } from 'zod'

export interface FileHookReadResult {
  additionalContext?: string
}

export interface FileHookWriteResult {
  /** If set, the write is rejected and this message is returned to the model. */
  error?: string
  /** Non-blocking warning appended as additional context. */
  warning?: string
}

export interface FileHookChangeResult {
  /** Appended to the tool result as additional context. */
  warning?: string
}

/**
 * Base class for file-specific hooks that intercept Read, Write, and Edit
 * tool calls for particular files. Subclasses define which files they match
 * and provide read hints / write validations.
 *
 * This is designed to be subclassed for each special file the agent manages
 * (e.g. bookmarks.json, config files, etc.).
 */
export abstract class FileHook {
  /**
   * Returns a glob-style pattern describing which files this hook handles.
   * Used for documentation / logging. Actual matching uses `matches()`.
   */
  abstract pattern(): string

  /**
   * Returns true if this hook should handle the given file path.
   */
  abstract matches(filePath: string): boolean

  /**
   * Called after a Read tool call for a matching file, with what the Read returned.
   * Return additional context to append to the tool result.
   */
  onRead(_filePath: string, _response?: unknown): FileHookReadResult {
    return {}
  }

  /**
   * Called before a Write tool call for a matching file.
   * Receives the full file content that will be written.
   * Return an error to reject the write, or a warning to allow but annotate.
   */
  onWrite(_filePath: string, _content: string): FileHookWriteResult {
    return {}
  }

  /**
   * Called after an Edit tool call for a matching file.
   * Receives the full file content after the edit was applied.
   * Return an error message (as warning since edit already happened) or a warning.
   */
  onEdit(_filePath: string, _contentAfterEdit: string): FileHookWriteResult {
    return {}
  }

  /**
   * Called after a Write or Edit tool call changed a matching file, with its
   * content before the call (null when it did not exist) and after. For hooks
   * that act on what the change did rather than on the content alone; the
   * change has landed, so it cannot be rejected here. Optional: the file is
   * read before the call only for hooks that define it.
   */
  onChange?(filePath: string, before: string | null, after: string): FileHookChangeResult
}

/**
 * Resolves a file path from tool input, normalizing to an absolute path
 * relative to the working directory.
 */
export function resolveToolFilePath(toolInput: Record<string, unknown>, workingDirectory: string): string | null {
  const filePath = toolInput.file_path as string | undefined
  if (!filePath) return null
  return path.resolve(workingDirectory, filePath)
}

const editResponseSchema = z.object({ originalFile: z.string(), oldString: z.string(), newString: z.string(), replaceAll: z.boolean().optional() })

/** The file after an Edit, rebuilt from the tool's reply so hooks need not read it back. Null when the reply has no original. */
export function editedContent(response: unknown): string | null {
  const edit = editResponseSchema.safeParse(response)
  if (!edit.success) return null
  const { originalFile, oldString, newString, replaceAll } = edit.data
  return replaceAll ? originalFile.split(oldString).join(newString) : originalFile.replace(oldString, () => newString)
}
