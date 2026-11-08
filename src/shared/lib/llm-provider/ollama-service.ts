import { background } from '../background'
import { PassTask, taskManager, type Service } from '../background-work'
import { syncAllOllamaCatalogs } from './ollama-catalog-sync'
import { ollamaPullTask } from './ollama-pull'

/** Keeps catalogs current with models pulled or removed outside the app, such as `ollama pull` in a terminal. */
export class OllamaCatalogService implements Service {
  readonly id = 'ollama-catalog'
  readonly phase = 'background' as const
  private readonly syncTask = new PassTask('ollama.catalog-sync', syncAllOllamaCatalogs)
  readonly tasks = [this.syncTask, ollamaPullTask]

  async start(): Promise<void> {
    await taskManager().ensureEvery(this.syncTask.type, this.syncTask.spec, { intervalMs: 60_000, initialDelayMs: 5_000 })
  }

  stop(): void {
    background(taskManager().cancel(this.syncTask.type), { name: 'ollama-catalog.cancel-sync' })
  }
}
