import type { UserInputRequestKind } from './request-schema'

export interface RequestNotification {
  title: string
  body: string
}

/** Shared presentation metadata; this entry point must not import React views. */
export interface RequestDefinition<K extends UserInputRequestKind = UserInputRequestKind> {
  kind: K
  /** Conditional approval handlers decide when this request starts awaiting. */
  syncsAwaitingItself?: boolean
  getNotification: (
    agentName: string,
    payload: Record<string, unknown>,
  ) => RequestNotification | null
}

export function waitingInputNotification(message: string): RequestDefinition['getNotification'] {
  return (agentName) => ({ title: 'Action Required', body: `${agentName} ${message}` })
}
