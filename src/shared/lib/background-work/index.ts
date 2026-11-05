/**
 * Scheduled work and service lifecycle, behind interfaces a backend can
 * implement. docs/background-work.md has the contract and how to add a Task or a
 * Service.
 */
export { emptyPayloadSchema, PassTask, Task, TaskManager } from './task'
export type { EmptyPayload, PeriodicOptions, RetryPolicy, TaskContext, TaskResult, TaskSpec } from './task'
export { LocalTaskManager } from './local-task-manager'
export type { LocalJobInfo, LocalTaskInfo, LocalTaskManagerOptions, TaskFailureContext } from './local-task-manager'
export { ServiceHost } from './service-host'
export type { Service, ServiceHostOptions, ServicePhase, ServiceState } from './service-host'
export {
  closeBackgroundWork,
  initializeBackgroundWork,
  initializeLocalBackgroundWork,
  isBackgroundWorkInitialized,
  serviceHost,
  taskManager,
} from './global'
