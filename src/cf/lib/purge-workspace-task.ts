/**
 * Removes a deleted agent's saved workspace (its file list and its files in R2), as a task: the
 * agent's row is gone by then, so a purge that fails is tried again here, or nothing would.
 */
import { z } from 'zod'
import { Task, type RetryPolicy, type TaskResult } from '@shared/lib/background-work/task'

const payloadSchema = z.object({ slug: z.string().min(1) }).strict()
type Payload = z.infer<typeof payloadSchema>

export const PURGE_WORKSPACE_TASK = 'cloudflare.purge-workspace'

export class PurgeWorkspaceTask extends Task<Payload> {
  readonly type = PURGE_WORKSPACE_TASK
  readonly payloadSchema = payloadSchema
  readonly retryPolicy: RetryPolicy = { delaysMs: [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000], maxAttempts: 10 }

  constructor(private readonly purge: (slug: string) => Promise<void>) {
    super()
  }

  async execute({ slug }: Payload): Promise<TaskResult<Payload>> {
    await this.purge(slug)
    return { kind: 'done' }
  }
}
