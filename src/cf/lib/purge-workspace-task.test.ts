import { describe, expect, it } from 'vitest'
import { PURGE_WORKSPACE_TASK, PurgeWorkspaceTask } from './purge-workspace-task'


describe('PurgeWorkspaceTask', () => {
  it('purges the agent named in its payload', async () => {
    const purged: string[] = []
    const task = new PurgeWorkspaceTask(async (slug) => void purged.push(slug))
    expect(await task.execute(task.payloadSchema.parse({ slug: 'sales' }))).toEqual({ kind: 'done' })
    expect(purged).toEqual(['sales'])
    expect(task.type).toBe(PURGE_WORKSPACE_TASK)
  })

  it('lets a failed purge fail, so the task manager tries it again by its retry policy', async () => {
    const task = new PurgeWorkspaceTask(async () => {
      throw new Error('R2 is unavailable')
    })
    await expect(task.execute({ slug: 'sales' })).rejects.toThrow('R2 is unavailable')
    expect(task.retryPolicy.maxAttempts).toBeGreaterThan(1)
  })
})
