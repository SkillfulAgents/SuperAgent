import { background } from '../background'
import { emptyPayloadSchema, Task, taskManager, type EmptyPayload, type Service, type TaskContext, type TaskResult } from '../background-work'
import { captureException } from '../error-reporting'
import { syncAllOllamaCatalogs } from './ollama-catalog-sync'
import { OLLAMA_CATALOG_SYNC_TASK, ollamaPullTask } from './ollama-pull'

export const OLLAMA_CATALOG_SYNC_INTERVAL_MS = 60_000
const FIRST_PASS_DELAY_MS = 5_000

/**
 * One pass over every Ollama connection, which arranges the next one itself and
 * only while there is a connection to keep current. With none, the passes stop,
 * and nothing wakes the app or reads the database for a provider nobody set up.
 * Saving an Ollama connection asks for a pass (`requestOllamaCatalogSync()`),
 * which starts them again.
 */
class OllamaCatalogSyncTask extends Task<EmptyPayload> {
  readonly type = OLLAMA_CATALOG_SYNC_TASK
  readonly payloadSchema = emptyPayloadSchema

  constructor(private readonly pass: () => Promise<number>) { super() }

  async execute(_payload: EmptyPayload, ctx: TaskContext): Promise<TaskResult<EmptyPayload>> {
    let connections: number | undefined
    try {
      connections = await this.pass()
    } catch (error) {
      // Not known to be zero, so the passes go on: a throw must not end them for good.
      console.error('[ollama] Catalog sync failed:', error)
      captureException(error, { tags: { taskType: this.type } })
    }
    if (connections === 0) return { kind: 'done' }
    return { kind: 'next', at: ctx.now() + OLLAMA_CATALOG_SYNC_INTERVAL_MS, payload: {} }
  }
}

/** Keeps catalogs current with models pulled or removed outside the app, such as `ollama pull` in a terminal. */
export class OllamaCatalogService implements Service {
  readonly id = 'ollama-catalog'
  readonly phase = 'background' as const
  private readonly syncTask = new OllamaCatalogSyncTask(syncAllOllamaCatalogs)
  readonly tasks: NonNullable<Service['tasks']> = [this.syncTask, ollamaPullTask]

  /** One pass to learn whether there is anything to keep current; that pass decides whether more follow. */
  async start(): Promise<void> {
    await taskManager().at(Date.now() + FIRST_PASS_DELAY_MS, this.syncTask.type, { taskType: this.syncTask.type, payload: {} })
  }

  stop(): void {
    background(taskManager().cancel(this.syncTask.type), { name: 'ollama-catalog.cancel-sync' })
  }
}
