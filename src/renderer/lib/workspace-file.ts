import { getPathName, isFolderPath, toWorkspaceRelativePath } from '@shared/lib/utils/workspace-path'
import { fileCategory, isPreviewableImage, previewKind, type FileCategory, type PreviewKind } from './file-types'
import { getAgentFileApiPath, getAgentFileUrl } from './workspace-file-url'

/**
 * Everything the renderer knows about one file in one agent's workspace.
 *
 * Ten surfaces draw "a workspace file as a clickable thing" — the delivery row,
 * the download pill, the tab strip, the folder browser, the bookmarks list, a
 * sent message's chips, the drawer's own header and its unsupported-file
 * screen. Each used to re-derive the same handful of facts from the raw path,
 * and the answers had already started to disagree: the same picture inlined in
 * Markdown but not in the drawer, the same file named two ways on one screen.
 *
 * A path plus a slug is all any of them has, so a path plus a slug is what this
 * takes. Everything below is derived, so the next surface asks rather than
 * re-deriving.
 */
export interface WorkspaceFile {
  /** The container path exactly as it was handed over — the identity, unaltered. */
  path: string
  agentSlug: string
  /** Last segment, without a folder's trailing slash: what to put on a label. */
  name: string
  /** Path below the workspace root: what to put on a second line under the name. */
  relativePath: string
  /** A folder is written with a trailing slash; a file never is. */
  isFolder: boolean
  /** Which icon it gets. */
  category: FileCategory
  /** The drawer's renderer for it, or null when the drawer has none. */
  preview: PreviewKind | null
  /** Whether opening it in the drawer shows anything (folders open the browser instead). */
  previewable: boolean
  /** Whether to draw it as the picture itself rather than as a named chip. */
  isImage: boolean
  /** Route path for a fetch or a HEAD. Null for a folder, which has no bytes. */
  apiPath: string | null
  /** `href` that saves the file. Null for a folder. */
  downloadUrl: string | null
  /** `src` that displays the file in place. Null for a folder. */
  inlineUrl: string | null
}

export interface DescribeWorkspaceFileOptions {
  /**
   * The preview tab's cache-busting token, folded into both URLs. Only the
   * drawer has one — everywhere else a path is either immutable or re-read on
   * its own schedule. See `getAgentFileUrl`.
   */
  version?: number
}

/** Describe a workspace path for whichever surface is about to draw it. */
export function describeWorkspaceFile(
  filePath: string,
  agentSlug: string,
  { version = 0 }: DescribeWorkspaceFileOptions = {},
): WorkspaceFile {
  const isFolder = isFolderPath(filePath)
  const preview = isFolder ? null : previewKind(filePath)

  return {
    path: filePath,
    agentSlug,
    name: getPathName(filePath),
    relativePath: toWorkspaceRelativePath(filePath),
    isFolder,
    category: fileCategory(filePath),
    preview,
    previewable: preview !== null,
    isImage: isPreviewableImage(filePath),
    // The file route serves bytes. A folder has none, and asking for one
    // returns a 404 rather than a listing, so it gets no URL at all instead of
    // one that only fails when followed.
    apiPath: isFolder ? null : getAgentFileApiPath(agentSlug, filePath),
    downloadUrl: isFolder ? null : getAgentFileUrl(agentSlug, filePath, { version }),
    inlineUrl: isFolder ? null : getAgentFileUrl(agentSlug, filePath, { inline: true, version }),
  }
}
