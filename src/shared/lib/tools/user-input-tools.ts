import { getRegisteredDefinitionNames, getToolDefinition } from './registry'
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

/**
 * The blocking kind of a request the container reports parked, named by its
 * input type (`GET /inputs/pending`) rather than by the tool that asked: the
 * kind of any tool whose requests establish a wait. Undefined for the input
 * types the host answers itself (scheduling, webhooks) and for the kinds
 * whose tools keep their own wait.
 */
export function getBlockingUserInputRequestKindForInputType(inputType: unknown): StreamRequestKind | undefined {
  if (typeof inputType !== 'string') return undefined
  for (const name of getRegisteredDefinitionNames()) {
    const kind = getBlockingUserInputRequestKind(name)
    if (kind === inputType) return kind
  }
  return undefined
}
