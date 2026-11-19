/**
 * Scheduled work and service lifecycle, behind interfaces a backend can
 * implement. docs/background-work.md has the contract and how to add a Task or a
 * Service. A backend is not exported here: an entry point imports the one it picks
 * from its own file.
 */
export { emptyPayloadSchema, PassTask, Task, TaskManager } from './task'
export type { EmptyPayload, PeriodicOptions, RetryPolicy, TaskContext, TaskResult, TaskSpec } from './task'
export { ServiceHost } from './service-host'
export type { Service, ServiceHostOptions, ServicePhase, ServiceState } from './service-host'
export {
  closeBackgroundWork,
  initializeBackgroundWork,
  isBackgroundWorkInitialized,
  serviceHost,
  stopBackgroundWork,
  taskManager,
} from './global'
