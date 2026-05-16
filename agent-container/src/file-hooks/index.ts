export { FileHook, resolveToolFilePath } from './file-hook'
export type { FileHookReadResult, FileHookWriteResult } from './file-hook'
export { BookmarksFileHook } from './bookmarks-hook'
export { bookmarksSchema, bookmarkSchema } from './bookmarks-schema'
export type { Bookmark } from './bookmarks-schema'
export { AgentPreferencesFileHook } from './agent-preferences-hook'

import { type FileHook } from './file-hook'
import { BookmarksFileHook } from './bookmarks-hook'
import { AgentPreferencesFileHook } from './agent-preferences-hook'

/** All registered file hooks. Add new FileHook subclasses here. */
export const fileHooks: FileHook[] = [
  new BookmarksFileHook(),
  new AgentPreferencesFileHook(),
]
