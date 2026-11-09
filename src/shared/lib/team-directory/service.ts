/** The team directories' background work: renewing app-creation credentials (provisioning.ts). */
import { background } from '@shared/lib/background'
import { PassTask, taskManager, type Service } from '@shared/lib/background-work'
import { rotateAllProvisioning } from './provisioning'

export const PROVISIONING_ROTATION_INTERVAL_MS = 6 * 60 * 60_000
const ROTATE_TASK = 'team-directory.rotate-provisioning'

/** Keeps provisioning credentials renewed even when no app is made for weeks. */
export class TeamDirectoryProvisioningService implements Service {
  readonly id = 'team-directory-provisioning'
  readonly phase = 'background' as const
  private readonly rotateTask = new PassTask(ROTATE_TASK, rotateAllProvisioning)
  readonly tasks = [this.rotateTask]

  async start(): Promise<void> {
    await taskManager().ensureEvery(this.rotateTask.type, this.rotateTask.spec, { intervalMs: PROVISIONING_ROTATION_INTERVAL_MS, initialDelayMs: 60_000 })
  }

  stop(): void {
    background(taskManager().cancel(this.rotateTask.type), { name: 'team-directory.cancel-rotation' })
  }
}
