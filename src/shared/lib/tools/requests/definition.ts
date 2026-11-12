import type { UserInputRequestKind } from './request-schema'
import type { PendingRequestDescriptor } from './types'

export interface RequestNotification {
  title: string
  body: string
}

/** Who a request waits on, as its notification names them. */
export interface RequestAudience {
  name: string
  possessive: string
}

/** Whoever reads the notification: without sign-in there is only one person. */
export const READER: RequestAudience = { name: 'you', possessive: 'your' }

/** A person by name: with sign-in every member reads the same notification. */
export function namedAudience(name: string): RequestAudience {
  return { name, possessive: `${name}'s` }
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
    audience?: RequestAudience,
  ) => RequestNotification | null
}

export type AnyRequestDefinition = {
  [K in UserInputRequestKind]: RequestDefinition<K>
}[UserInputRequestKind]

export function waitingInputNotification(
  message: string | ((audience: RequestAudience) => string),
): RequestDefinition['getNotification'] {
  return (agentName, _payload, audience = READER) => ({
    title: 'Action Required',
    body: `${agentName} ${typeof message === 'string' ? message : message(audience)}`,
  })
}
