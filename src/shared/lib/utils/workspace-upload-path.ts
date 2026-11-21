import * as path from 'path'
import { normalizeWorkspacePath } from '@shared/lib/agent-actor/workspace-path'
import { sanitizeUploadFilename, withUploadTimestamp } from './path-safety'

/** The workspace folder every upload into an agent lands in. */
export const UPLOADS_DIR = 'uploads'

/**
 * The workspace path an upload lands at, always inside `uploads/`. Shared by
 * the upload-file routes and signed upload URLs.
 */
export function resolveUploadDestPath(filename: string, relativePath?: string): string {
  // If relativePath is provided (folder upload), preserve directory structure
  let uploadPath: string
  if (relativePath) {
    const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '')
    uploadPath = `${UPLOADS_DIR}/${normalized}`
  } else {
    // Single-file upload: collapse the untrusted name to a safe basename
    // (shared with the chat-attachment write path). The check below is the
    // defense-in-depth backstop.
    uploadPath = `${UPLOADS_DIR}/${withUploadTimestamp(sanitizeUploadFilename(filename))}`
  }

  // Security: the actor keeps the write inside the workspace; this keeps it
  // inside the one folder uploads are allowed into.
  if (!normalizeWorkspacePath(uploadPath).startsWith(`${UPLOADS_DIR}/`)) {
    throw new Error('Invalid file path')
  }

  return uploadPath
}
