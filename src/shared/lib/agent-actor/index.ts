export { agentRegistry } from './registry'
export { containerHost, type ContainerHost } from './host'
export { agentCatalog } from './local-agent-catalog'
export { copyHostDirIntoWorkspace } from './copy-into-workspace'
export { CONFIG_DOCS, ConfigDocError, type ConfigDoc, type ConfigDocErrorCode, type ConfigDocId } from './config-schema'
// Pure helpers of the fenced transcript modules that routes still need: how a
// media reference is spelled in a URL, and how session lists are ordered and
// capped.
export { decodeMediaRef, encodeMediaRef, type MediaRef } from '@shared/lib/services/session-media'
export {
  SESSIONS_LIST_MAX_LIMIT,
  sortSessionsNewestFirst,
  type ListSessionsOptions,
  type SessionSortBy,
} from '@shared/lib/services/session-service'
export {
  WorkspaceFileError,
  joinWorkspacePath,
  normalizeWorkspacePath,
  workspaceBasename,
  workspaceDirname,
  type WorkspaceFileErrorCode,
} from './workspace-path'
export type {
  AgentActor,
  AgentCatalog,
  AgentRegistry,
  AgentSlug,
  ByteRange,
  ComputerUseOps,
  ConfigOps,
  ContainerOps,
  FileEntry,
  FileKind,
  FileOps,
  FileStat,
  InputOps,
  McpReauthOps,
  MediaBlob,
  MessageOps,
  OpenFile,
  SubagentRef,
  OpenWebSocketInit,
  ReviewOps,
  SessionOps,
  UsageOps,
  WriteOptions,
} from './types'
