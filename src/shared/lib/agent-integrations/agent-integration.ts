import { captureException } from '../error-reporting'
import type {
  AgentIntegrationDefinition, AgentIntegrationRecord, IntegrationEvent,
  IntegrationInputContext, IntegrationInputEvent, IntegrationOutput,
  IntegrationRoute, IntegrationSessionContext, IntegrationSessionPolicy,
  IntegrationTool, PreparedIntegrationInput,
} from './types'

/** Application-facing lifecycle, input, and output contract for every integration. */
export abstract class AgentIntegration {
  abstract readonly provider: string
  abstract readonly definition: AgentIntegrationDefinition
  private eventHandlers = new Set<(event: IntegrationEvent) => void | Promise<void>>()
  protected errorHandlers: Array<(error: Error) => void> = []

  abstract connect(): Promise<void>
  abstract disconnect(): Promise<void>
  abstract isConnected(): boolean
  abstract resolveRoute(event: IntegrationInputEvent): IntegrationRoute
  abstract authorize(context: IntegrationSessionContext, event: IntegrationInputEvent): Promise<boolean>
  abstract isAllowed(context: IntegrationSessionContext): boolean
  abstract sessionPolicy(integration: AgentIntegrationRecord, route: Partial<IntegrationRoute>): IntegrationSessionPolicy
  abstract prepareInput(event: IntegrationInputEvent, context: IntegrationInputContext): Promise<PreparedIntegrationInput>
  abstract deliver(context: IntegrationSessionContext, output: IntegrationOutput): Promise<void>

  async consumeInput(_event: IntegrationInputEvent, _context: IntegrationInputContext, _input: PreparedIntegrationInput): Promise<boolean> { return false }
  getTools(_context: IntegrationSessionContext): readonly IntegrationTool[] { return [] }
  shouldUpdateDisplayName(current: string | null | undefined): boolean { return !current }
  describeTarget(_externalId: string): { type?: string } { return {} }
  observeSession(_context: IntegrationSessionContext): void {}
  releaseSession(_context: IntegrationSessionContext): void {}
  async onCreated(_integration: AgentIntegrationRecord): Promise<void> {}

  onEvent(handler: (event: IntegrationEvent) => void | Promise<void>): () => void {
    this.eventHandlers.add(handler)
    return () => { this.eventHandlers.delete(handler) }
  }

  /** Await acceptance into the host queue, not completion of the agent run. */
  protected async emitEvent(event: IntegrationEvent): Promise<void> {
    await Promise.all([...this.eventHandlers].map(handler => Promise.resolve().then(() => handler(event))))
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.push(handler)
    return () => { this.errorHandlers = this.errorHandlers.filter(h => h !== handler) }
  }

  protected emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try { handler(error) } catch (err) {
        captureException(err, { tags: { component: 'agent-integration', operation: 'error-handler' }, extra: { provider: this.provider } })
      }
    }
  }
}
