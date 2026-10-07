import type { UserInputRequestKind } from './request-schema'
import type { PendingRequestDescriptor } from './types'

export interface RequestNotification {
  title: string
  body: string
}

/** Shared presentation metadata; this entry point must not import React views. */
export interface RequestDefinition<K extends UserInputRequestKind = UserInputRequestKind> {
  kind: K
  /** Conditional approval handlers decide when this request starts awaiting. */
  syncsAwaitingItself?: boolean
  describeVoice: (request: Extract<PendingRequestDescriptor, { kind: K }>) => string
  getNotification: (
    agentName: string,
    payload: Record<string, unknown>,
  ) => RequestNotification | null
}

export type AnyRequestDefinition = {
  [K in UserInputRequestKind]: RequestDefinition<K>
}[UserInputRequestKind]

export function waitingInputNotification(message: string): RequestDefinition['getNotification'] {
  return (agentName) => ({ title: 'Action Required', body: `${agentName} ${message}` })
}
