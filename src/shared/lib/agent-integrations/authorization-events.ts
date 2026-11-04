/**
 * Authorization changes of one integration, for whichever process runs its
 * connection: `events:integration:{integrationId}:authorization`.
 *
 * An event is a hint to re-read the installation row, which stays the
 * authority: every use of a credential checks the row, and durable work that
 * must follow a change is done by the writer. Events carry IDs only, never a
 * credential.
 */
import { z } from 'zod'
import { appState, defineTopic } from '../app-state'
import { background } from '../background'
import { captureException } from '../error-reporting'

export const integrationAuthorizationEventSchema = z.discriminatedUnion('type', [
  /**
   * A terminal rejection cleared the credential and stopped the installation
   * (`requireIntegrationReconnect`). A credential refresh sends nothing.
   */
  z.object({ type: z.literal('authorization_lost'), integrationId: z.string().min(1) }),
])
export type IntegrationAuthorizationEvent = z.infer<typeof integrationAuthorizationEventSchema>

/** Channel: `integrationAuthorization.channel(integrationId)`. */
export const integrationAuthorization = defineTopic({ name: 'events:integration:authorization', schema: integrationAuthorizationEventSchema })

/** Sent after the write it describes has succeeded. Resolves once accepted, not once handled. */
export async function publishIntegrationAuthorization(event: IntegrationAuthorizationEvent): Promise<void> {
  await appState().publish(integrationAuthorization.channel(event.integrationId), event)
}

/**
 * An owner's subscriptions to the authorization channels of the integrations
 * it runs, one per integration until it is released or the watch is closed.
 * A subscription that failed is forgotten, so watching again rebuilds it.
 */
export class IntegrationAuthorizationWatch {
  private readonly watches = new Map<string, AbortController>()

  constructor(private readonly onEvent: (event: IntegrationAuthorizationEvent) => Promise<void>) {}

  watch(integrationId: string): void {
    if (this.watches.has(integrationId)) return
    const watching = new AbortController()
    this.watches.set(integrationId, watching)
    background(async () => {
      try {
        await appState().subscribe([integrationAuthorization.channel(integrationId)], event => this.onEvent(event), { signal: watching.signal })
      } catch (error) {
        if (this.watches.get(integrationId) === watching) this.watches.delete(integrationId)
        if (!watching.signal.aborted) captureException(error, { tags: { component: 'agent-integration', operation: 'authorization-subscribe' }, extra: { integrationId } })
      }
    }, { name: 'integration-authorization.subscribe' })
  }

  release(integrationId: string): void {
    this.watches.get(integrationId)?.abort()
    this.watches.delete(integrationId)
  }

  /** Ends every subscription, including one still being set up. */
  close(): void {
    for (const watching of this.watches.values()) watching.abort()
    this.watches.clear()
  }
}
