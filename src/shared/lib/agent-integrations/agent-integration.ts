import { captureException } from '../error-reporting'
import type {
  AgentIntegrationDefinition, AgentIntegrationRecord, IntegrationEvent,
  IntegrationInputContext, IntegrationInputEvent, IntegrationOutput,
  IntegrationRoute, IntegrationSessionContext, IntegrationSessionPolicy,
  IntegrationTool, PreparedIntegrationInput, IntegrationHost, IntegrationSessionRecovery,
} from './types'

/** Application-facing lifecycle, input, and output contract for every integration. */
export abstract class AgentIntegration {
  abstract readonly provider: string
  abstract readonly definition: AgentIntegrationDefinition
  private eventHandlers = new Set<(event: IntegrationEvent) => void | Promise<void>>()
  protected errorHandlers: Array<(error: Error) => void> = []
  private recoveredHandlers = new Set<() => void>()

  private runtimeHost?: IntegrationHost
  protected get host(): IntegrationHost {
    if (!this.runtimeHost) throw new Error('The integration manager has not bound its host')
    return this.runtimeHost
  }
  /** Bound before connect; providers receive no container or actor controls here. */
  bindHost(host: IntegrationHost): void { this.runtimeHost = host }
  /** Only unfinished local work needs proactive runtime recovery on connection. */
  async sessionsToRecover(): Promise<readonly IntegrationSessionRecovery[]> { return [] }

  abstract connect(): Promise<void>
  abstract disconnect(): Promise<void>
  abstract isConnected(): boolean
  abstract resolveRoute(event: IntegrationInputEvent): IntegrationRoute
  abstract authorize(context: IntegrationSessionContext, event: IntegrationInputEvent): Promise<boolean>
  abstract isAllowed(context: IntegrationSessionContext): Promise<boolean>
  abstract sessionPolicy(integration: AgentIntegrationRecord, route: Partial<IntegrationRoute>): IntegrationSessionPolicy
  abstract prepareInput(event: IntegrationInputEvent, context: IntegrationInputContext): Promise<PreparedIntegrationInput>
  abstract deliver(context: IntegrationSessionContext, output: IntegrationOutput): Promise<void>

  /** Called only after a new provider event has been durably accepted. Best-effort UX. */
  async acknowledgeInput(_event: IntegrationInputEvent): Promise<void> {}

  async consumeInput(_event: IntegrationInputEvent, _context: IntegrationInputContext, _input: PreparedIntegrationInput): Promise<boolean> { return false }
  getTools(_context: IntegrationSessionContext): readonly IntegrationTool[] { return [] }
  shouldUpdateDisplayName(current: string | null | undefined): boolean { return !current }
  observeSession(_context: IntegrationSessionContext): void {}
  releaseSession(_context: IntegrationSessionContext): void {}
  async onCreated(_integration: AgentIntegrationRecord): Promise<void> {}

  onEvent(handler: (event: IntegrationEvent) => void | Promise<void>): () => void {
    this.eventHandlers.add(handler)
    return () => { this.eventHandlers.delete(handler) }
  }

  /** Await all event handlers. The host queues inputs but may process responses inline. */
  protected async emitEvent(event: IntegrationEvent): Promise<void> {
    await Promise.all([...this.eventHandlers].map(handler => Promise.resolve().then(() => handler(event))))
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.push(handler)
    return () => { this.errorHandlers = this.errorHandlers.filter(h => h !== handler) }
  }

  onRecovered(handler: () => void): () => void {
    this.recoveredHandlers.add(handler)
    return () => { this.recoveredHandlers.delete(handler) }
  }

  /** The transport is healthy again after an emitted error. */
  protected emitRecovered(): void {
    for (const handler of this.recoveredHandlers) handler()
  }

  protected emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try { handler(error) } catch (err) {
        captureException(err, { tags: { component: 'agent-integration', operation: 'error-handler' }, extra: { provider: this.provider } })
      }
    }
  }
}
