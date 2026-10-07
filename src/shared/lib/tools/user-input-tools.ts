import { getToolDefinition } from './registry'
import { isStreamRequestKind, type StreamRequestKind } from './requests/request-schema'

/** Requests whose stream delivery and transcript recovery both establish a wait. */
export function getBlockingUserInputRequestKind(toolName: unknown): StreamRequestKind | undefined {
  const request = typeof toolName === 'string' ? getToolDefinition(toolName)?.request : undefined
  return request && !request.syncsAwaitingItself && isStreamRequestKind(request.kind)
    ? request.kind
    : undefined
}

export function isBlockingUserInputToolName(toolName: unknown): boolean {
  return getBlockingUserInputRequestKind(toolName) !== undefined
}
