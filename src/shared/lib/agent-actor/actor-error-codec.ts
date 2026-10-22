/**
 * An error as it crosses the actor's boundary. Structured clone keeps a
 * thrown error's message but not its class or its own fields, and callers
 * branch on both (`instanceof WorkspaceFileError`, `findAgentRuntimeError`,
 * a `DeliveryError`'s `code`). A transport encodes what the actor threw as
 * data on one side and rebuilds it on the other: the errors callers know are
 * rebuilt as their own class, any other one as an `Error` that keeps its name
 * and fields. The cause chain goes the same way.
 */
import { WorkspaceFileError, type WorkspaceFileErrorCode } from './workspace-path'
import { MemoryError } from './memory-schema'
import { ConfigDocError, type ConfigDocErrorCode, type ConfigDocId } from './config-schema'
import { DeliveryError, StartError, type DeliveryErrorCode, type StartErrorCode } from './delivery-errors'
import { MessageNotAcceptedError } from '@shared/lib/container/message-dispatch-error'
import { ContainerConflictError, ContainerNotFoundError } from '@shared/lib/container/types'
import { LlmProviderNotFoundError } from '@shared/lib/agent-runtime-errors/llm-provider-not-found/llm-provider-not-found-error'
import { ProviderReconnectRequiredError } from '@shared/lib/agent-runtime-errors/provider-reconnect-required/provider-reconnect-required-error'
import { ProviderRefreshUnavailableError } from '@shared/lib/agent-runtime-errors/provider-refresh-unavailable/provider-refresh-unavailable-error'

/** A thrown error as data. */
export interface ActorErrorData {
  name: string
  message: string
  /** Where it was thrown, on the actor's side. */
  stack?: string
  /** Its own fields that are data (`code`, `status`, `accepted`, …); methods and class instances are left behind. */
  fields: Record<string, unknown>
  cause?: ActorErrorData | { value: unknown }
}

/** What the actor threw, as data a transport can carry. */
export function encodeActorError(error: unknown): ActorErrorData {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error), fields: {}, cause: { value: dataOrUndefined(error) } }
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(error)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue
    const data = plainData(value)
    if (data !== OMIT) fields[key] = data
  }
  const encoded: ActorErrorData = { name: error.name, message: error.message, stack: error.stack, fields }
  if (error.cause !== undefined) {
    encoded.cause = error.cause instanceof Error ? encodeActorError(error.cause) : { value: dataOrUndefined(error.cause) }
  }
  return encoded
}

/** The error a caller sees: the class it knows by name, or an `Error` with the same name and fields. */
export function decodeActorError(data: ActorErrorData): Error {
  const cause = data.cause === undefined ? undefined : 'value' in data.cause ? data.cause.value : decodeActorError(data.cause)
  const revive = REVIVERS[data.name]
  const error = revive ? revive(data.fields, data.message, cause) : Object.assign(new Error(data.message, { cause }), data.fields)
  // Set only where the rebuilt error differs (a constructor that words its own
  // message, an unknown class): an own `name` would set it apart from one never sent.
  if (error.name !== data.name) error.name = data.name
  if (error.message !== data.message) error.message = data.message
  if (data.stack !== undefined) error.stack = data.stack
  return error
}

type Reviver = (fields: Record<string, unknown>, message: string, cause: unknown) => Error

// The errors the actor throws that callers branch on, rebuilt with their own
// constructors: their class fields (a status, a response schema) come back too.
const REVIVERS: Record<string, Reviver> = {
  // The built-in classes, which structured clone itself keeps.
  TypeError: (_f, message, cause) => new TypeError(message, { cause }),
  RangeError: (_f, message, cause) => new RangeError(message, { cause }),
  SyntaxError: (_f, message, cause) => new SyntaxError(message, { cause }),
  WorkspaceFileError: (f, message) => new WorkspaceFileError(f.code as WorkspaceFileErrorCode, message),
  MemoryError: (f, message) => new MemoryError(message, f.status as MemoryError['status']),
  ConfigDocError: (f, message, cause) => new ConfigDocError(f.code as ConfigDocErrorCode, f.docId as ConfigDocId, message, { cause }),
  DeliveryError: (f, message, cause) =>
    new DeliveryError(f.code as DeliveryErrorCode, message, { cause, ...(typeof f.status === 'number' ? { status: f.status } : {}) }),
  StartError: (f, message, cause) => new StartError(f.code as StartErrorCode, f.revoked === true, message, { cause }),
  MessageNotAcceptedError: (f, message, cause) =>
    new MessageNotAcceptedError(f.reason as MessageNotAcceptedError['reason'], message, { cause }),
  ContainerConflictError: (_f, message) => new ContainerConflictError(message),
  ContainerNotFoundError: (_f, message) => new ContainerNotFoundError(message),
  LlmProviderNotFoundError: () => new LlmProviderNotFoundError(),
  ProviderReconnectRequiredError: (_f, message, cause) => new ProviderReconnectRequiredError(message, { cause }),
  ProviderRefreshUnavailableError: (_f, message, cause) => new ProviderRefreshUnavailableError(message, { cause }),
}

const OMIT = Symbol('omit')

function dataOrUndefined(value: unknown): unknown {
  const data = plainData(value)
  return data === OMIT ? undefined : data
}

/** A value as structured clone would carry it, or OMIT when it is not data (a function, a class instance). */
function plainData(value: unknown): unknown {
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return value
  if (typeof value !== 'object') return OMIT
  if (Array.isArray(value)) return value.map(plainData).filter((item) => item !== OMIT)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return OMIT
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const data = plainData(item)
    if (data !== OMIT) out[key] = data
  }
  return out
}
