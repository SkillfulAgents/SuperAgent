import { z } from 'zod'
import type { RelayAcceptResult, RelayEvent } from '../webhook-relay/types'

/**
 * How an integration can receive provider events:
 * - direct: the provider's own connection (a socket, a stream, polling)
 * - relay: webhooks the host's webhook relay receives and hands over
 *
 * Which one a connection uses is decided each time it connects: the relay if
 * the host has one and the installation's webhooks are set up, direct
 * otherwise. Nothing stores the choice.
 */
export const INTEGRATION_TRANSPORTS = ['direct', 'relay'] as const
export type IntegrationTransport = (typeof INTEGRATION_TRANSPORTS)[number]

/** The relay endpoint an integration's webhooks arrive at, and the scope that claims them. */
export const integrationRelayBindingSchema = z.object({
  endpointId: z.string().min(1),
  url: z.string().url(),
  scope: z.string().min(1),
})
export type IntegrationRelayBinding = z.infer<typeof integrationRelayBindingSchema>

/**
 * The relay field in an integration's stored config: present once its
 * webhooks are set up. Providers that support the relay spread this into
 * their config schema; a row without it has no webhooks.
 */
export const integrationRelayConfigShape = {
  relay: integrationRelayBindingSchema.optional(),
}
const integrationRelayConfigSchema = z.object(integrationRelayConfigShape).loose()

/** The relay endpoint in any provider's config, whatever else it holds. */
export function readIntegrationRelay(config: string | Record<string, unknown>): IntegrationRelayBinding | undefined {
  let raw: unknown = config
  if (typeof config === 'string') {
    try {
      raw = JSON.parse(config)
    } catch {
      throw new Error('Integration config is not valid JSON')
    }
  }
  return integrationRelayConfigSchema.parse(raw).relay
}

/**
 * A relay endpoint being provisioned, recorded before the mint: the platform's
 * create has no idempotency key, so a mint whose answer was lost can only be
 * found again by this random name. Only Email records these today, under
 * `relayProvisioning`, next to what it needs to adopt the endpoint it finds.
 */
export const integrationRelayIntentSchema = z.object({
  attemptId: z.string().regex(/^[0-9a-f]{16}$/),
  scope: z.string().min(1),
  endpointName: z.string().min(1).max(200),
})
export type IntegrationRelayIntent = z.infer<typeof integrationRelayIntentSchema>

const integrationRelayIntentConfigSchema = z.object({ relayProvisioning: integrationRelayIntentSchema.optional() }).loose()

/** The intent in any provider's config, whatever else it holds. */
export function readIntegrationRelayIntent(config: string): IntegrationRelayIntent | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(config)
  } catch {
    return undefined
  }
  return integrationRelayIntentConfigSchema.safeParse(raw).data?.relayProvisioning
}

/** The transports a provider supports; `direct` unless it says otherwise. */
export function supportedTransports(definition: { transports?: readonly IntegrationTransport[] }): readonly IntegrationTransport[] {
  return definition.transports ?? ['direct']
}

/** A provider that can't receive events without the webhook relay. */
export function requiresRelay(transports: readonly IntegrationTransport[]): boolean {
  return !transports.includes('direct')
}

export type IntegrationRelayAccept = (
  events: readonly RelayEvent[],
) => Promise<RelayAcceptResult | ReadonlyMap<string, RelayAcceptResult>>

export interface IntegrationRelayAttachment {
  /** This connection stops receiving; nothing is claimed until one attaches again. */
  detach(): void
  isAttached(): boolean
}

/** The host's relay, as handed to one connection of one integration. */
export interface IntegrationRelayHost {
  /** Starts receiving the events that arrive at this endpoint. */
  attach(binding: IntegrationRelayBinding, accept: IntegrationRelayAccept): IntegrationRelayAttachment
}
