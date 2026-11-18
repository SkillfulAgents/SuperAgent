import { taskManager } from '../global'
import type { Service } from '../service-host'

/**
 * What `ServiceHost.register` does with a service's tasks, for a test that starts
 * the service directly: the shared test setup installs a manager with nothing
 * registered.
 */
export function registerTasks(owner: { tasks?: Service['tasks'] }): void {
  for (const task of owner.tasks ?? []) taskManager().register(task)
}
