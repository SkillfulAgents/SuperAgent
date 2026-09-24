import { z } from 'zod'

/**
 * How an integration receives provider events:
 * - direct: the provider's own connection (a socket, a stream, polling)
 * - relay: webhooks the host's webhook relay receives and hands over
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
 * Transport fields in an integration's stored config. Providers that support
 * the relay spread this into their config schema; a row written before
 * transports existed reads as `direct`.
 */
export const integrationTransportConfigShape = {
  transport: z.enum(INTEGRATION_TRANSPORTS).default('direct'),
  relay: integrationRelayBindingSchema.optional(),
}
const integrationTransportConfigSchema = z.object(integrationTransportConfigShape).loose()
export type IntegrationTransportConfig = { transport: IntegrationTransport; relay?: IntegrationRelayBinding }

/** Reads the transport fields of any provider's config, whatever else it holds. */
export function readIntegrationTransport(config: string | Record<string, unknown>): IntegrationTransportConfig {
  let raw: unknown = config
  if (typeof config === 'string') {
    try {
      raw = JSON.parse(config)
    } catch {
      throw new Error('Integration config is not valid JSON')
    }
  }
  const { transport, relay } = integrationTransportConfigSchema.parse(raw)
  return { transport, ...(relay ? { relay } : {}) }
}

/** The transports a provider supports; `direct` unless it says otherwise. */
export function supportedTransports(definition: { transports?: readonly IntegrationTransport[] }): readonly IntegrationTransport[] {
  return definition.transports ?? ['direct']
}

/** A provider that can't receive events without the webhook relay. */
export function requiresRelay(transports: readonly IntegrationTransport[]): boolean {
  return !transports.includes('direct')
}

/** The relay when the provider supports it and the host has one; direct otherwise. */
export function defaultTransport(transports: readonly IntegrationTransport[], relayAvailable: boolean): IntegrationTransport {
  return transports.includes('relay') && (relayAvailable || requiresRelay(transports)) ? 'relay' : 'direct'
}
