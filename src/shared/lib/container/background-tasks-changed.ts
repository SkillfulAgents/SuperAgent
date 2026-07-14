// Single implementation lives in the agent-container tree (its Docker build
// context cannot reach files outside agent-container/, so sharing must point
// this way). The container's SessionManager consumes the full settlement
// tracker; the persister consumes the snapshot parsing re-exported here.
export {
  parseBackgroundTasksChanged,
  TERMINAL_TASK_UPDATED_STATUSES,
  TERMINAL_TASK_NOTIFICATION_STATUSES,
  type BackgroundTasksSnapshot,
} from '../../../../agent-container/src/session-settlement'
