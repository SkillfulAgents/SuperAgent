export { FileHook, resolveToolFilePath } from './file-hook'
export type { FileHookReadResult, FileHookWriteResult, FileHookChangeResult } from './file-hook'
export { BookmarksFileHook } from './bookmarks-hook'
export { bookmarksSchema, bookmarkSchema } from './bookmarks-schema'
export type { Bookmark } from './bookmarks-schema'
export { AgentPreferencesFileHook } from './agent-preferences-hook'
export { AgentIdentityFileHook } from './agent-identity-hook'
export { MountIndexFileHook, mountIndexCommandHint } from './mount-index-hook'
export { GithubConflictFileHook } from './github-conflict-hook'

import { type FileHook } from './file-hook'
import { BookmarksFileHook } from './bookmarks-hook'
import { AgentPreferencesFileHook } from './agent-preferences-hook'
import { AgentIdentityFileHook } from './agent-identity-hook'
import { MountIndexFileHook } from './mount-index-hook'
import { GithubConflictFileHook } from './github-conflict-hook'

/** All registered file hooks. Add new FileHook subclasses here. The first hook with something to say wins. */
export const fileHooks: FileHook[] = [
  new BookmarksFileHook(),
  new AgentPreferencesFileHook(),
  new AgentIdentityFileHook(),
  new GithubConflictFileHook(),
  new MountIndexFileHook(),
]
