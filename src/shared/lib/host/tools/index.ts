/**
 * Host tools: the agent tools whose work happens in the host app rather than
 * in the container (they read and write the app database, Composio and the
 * webhook relay). The container parks each call on a pending input; the
 * agent's actor hands the call to the host (`host.call('hostTool', …)`) and
 * delivers the result back to the container.
 */
import type { HostToolName, HostToolRequest, HostToolResult } from '@shared/lib/agent-actor/host-port'
import {
  cancelScheduledTaskTool,
  listScheduledTasks,
  pauseScheduledTaskTool,
  resumeScheduledTaskTool,
  scheduleResume,
  scheduleTask,
  updateScheduledTask,
} from './scheduling'
import { cancelTrigger, getAvailableTriggersTool, listTriggers, setupTrigger, updateTrigger } from './triggers'
import { createWebhookEndpoint, inspectWebhookEvents, updateWebhookEndpoint } from './webhook-endpoints'

const handlers: Record<HostToolName, (request: HostToolRequest) => Promise<HostToolResult>> = {
  schedule_task: scheduleTask,
  schedule_resume: scheduleResume,
  list_scheduled_tasks: listScheduledTasks,
  update_scheduled_task: updateScheduledTask,
  cancel_scheduled_task: cancelScheduledTaskTool,
  pause_scheduled_task: pauseScheduledTaskTool,
  resume_scheduled_task: resumeScheduledTaskTool,
  get_available_triggers: getAvailableTriggersTool,
  setup_trigger: setupTrigger,
  list_triggers: listTriggers,
  update_trigger: updateTrigger,
  cancel_trigger: cancelTrigger,
  create_webhook_endpoint: createWebhookEndpoint,
  update_webhook_endpoint: updateWebhookEndpoint,
  inspect_webhook_events: inspectWebhookEvents,
}

export function runHostTool(request: HostToolRequest): Promise<HostToolResult> {
  return handlers[request.toolName](request)
}
