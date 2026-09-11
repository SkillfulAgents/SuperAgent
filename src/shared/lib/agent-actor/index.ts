export { agentRegistry } from './registry'
export { containerHost, type ContainerHost } from './host'
// Pure helpers of the fenced transcript modules that routes still need: how a
// media reference is spelled in a URL, how session lists are ordered and
// capped, and the one-time storage migration startup runs over every agent.
export { decodeMediaRef, encodeMediaRef, type MediaRef } from '@shared/lib/services/session-media'
export {
  SESSIONS_LIST_MAX_LIMIT,
  removeLegacySessionOwnershipIndex,
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
  AgentRegistry,
  AgentSlug,
  ByteRange,
  ComputerUseOps,
  ContainerOps,
  FileEntry,
  FileKind,
  FileOps,
  FileStat,
  InputOps,
  McpReauthOps,
  MediaBlob,
  MessageOps,
  SubagentRef,
  OpenWebSocketInit,
  ReviewOps,
  SessionOps,
  UsageOps,
} from './types'
