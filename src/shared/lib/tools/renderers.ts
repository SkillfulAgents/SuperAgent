import type { ToolRenderer } from './renderer-types'
import { getToolDefinition, getRegisteredDefinitionNames } from './registry'
import { bashRenderer } from './bash/renderer'
import { readRenderer } from './read/renderer'
import { writeRenderer } from './write/renderer'
import { globRenderer } from './glob/renderer'
import { grepRenderer } from './grep/renderer'
import { webSearchRenderer } from './web-search/renderer'
import { webFetchRenderer } from './web-fetch/renderer'
import { todoWriteRenderer } from './todo-write/renderer'
import { askUserQuestionRenderer } from './ask-user-question/renderer'
import { requestSecretRenderer } from './request-secret/renderer'
import { requestConnectedAccountRenderer } from './request-connected-account/renderer'
import { scheduleTaskRenderer } from './schedule-task/renderer'
import { scheduleResumeRenderer } from './schedule-resume/renderer'
import { deliverFileRenderer } from './deliver-file/renderer'
import { deliverSessionRenderer } from './deliver-session/renderer'
import { requestFileRenderer } from './request-file/renderer'
import { requestRemoteMcpRenderer } from './request-remote-mcp/renderer'
import { requestScriptRunRenderer } from './request-script-run/renderer'
import { requestBrowserInputRenderer } from './request-browser-input/renderer'
import { taskRenderer } from './task/renderer'
import {
  browserOpenRenderer,
  browserCloseRenderer,
  browserSnapshotRenderer,
  browserClickRenderer,
  browserFillRenderer,
  browserScrollRenderer,
  browserWaitRenderer,
  browserPressRenderer,
  browserTypeRenderer,
  browserScreenshotRenderer,
  browserSelectRenderer,
  browserHoverRenderer,
  browserDownloadRenderer,
  browserEvalRenderer,
  browserRunRenderer,
} from './browser-tools/renderer'
import {
  createDashboardRenderer,
  startDashboardRenderer,
  listDashboardsRenderer,
  getDashboardLogsRenderer,
} from './dashboard-tools/renderer'
import {
  listAgentsRenderer,
  createAgentRenderer,
  invokeAgentRenderer,
  getAgentSessionsRenderer,
  getAgentSessionTranscriptRenderer,
  downloadAgentFileRenderer,
} from './x-agent-tools/renderer'
import {
  listChatProvidersRenderer,
  listAgentIntegrationsRenderer,
  addChatIntegrationRenderer,
  sendChatMessageRenderer,
} from './chat-tools/renderer'
import {
  taskCreateRenderer,
  taskUpdateRenderer,
  taskListRenderer,
} from './task-management/renderer'

export type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps, CollapsedContentProps } from './renderer-types'

/**
 * React bindings for the shared registry. Tool names and aliases live only in
 * registry.ts; renderers bind to their collocated definition objects.
 */
const toolRenderers = new Map([
  taskRenderer,
  bashRenderer,
  readRenderer,
  writeRenderer,
  globRenderer,
  grepRenderer,
  webSearchRenderer,
  webFetchRenderer,
  todoWriteRenderer,
  taskCreateRenderer,
  taskUpdateRenderer,
  taskListRenderer,
  askUserQuestionRenderer,
  requestSecretRenderer,
  requestConnectedAccountRenderer,
  scheduleTaskRenderer,
  scheduleResumeRenderer,
  deliverFileRenderer,
  deliverSessionRenderer,
  requestFileRenderer,
  requestRemoteMcpRenderer,
  requestScriptRunRenderer,
  requestBrowserInputRenderer,
  browserOpenRenderer,
  browserCloseRenderer,
  browserSnapshotRenderer,
  browserClickRenderer,
  browserFillRenderer,
  browserScrollRenderer,
  browserWaitRenderer,
  browserPressRenderer,
  browserTypeRenderer,
  browserScreenshotRenderer,
  browserSelectRenderer,
  browserHoverRenderer,
  browserDownloadRenderer,
  browserEvalRenderer,
  browserRunRenderer,
  createDashboardRenderer,
  startDashboardRenderer,
  listDashboardsRenderer,
  getDashboardLogsRenderer,
  listAgentsRenderer,
  createAgentRenderer,
  invokeAgentRenderer,
  getAgentSessionsRenderer,
  getAgentSessionTranscriptRenderer,
  downloadAgentFileRenderer,
  listChatProvidersRenderer,
  listAgentIntegrationsRenderer,
  addChatIntegrationRenderer,
  sendChatMessageRenderer,
].map(renderer => [renderer.definition, renderer]))

/**
 * Get the renderer for a specific tool, or undefined for fallback
 */
export function getToolRenderer(toolName: string): ToolRenderer | undefined {
  const definition = getToolDefinition(toolName)
  return definition ? toolRenderers.get(definition) : undefined
}

/**
 * Check if a tool has a custom renderer
 */
export function hasCustomRenderer(toolName: string): boolean {
  return getToolRenderer(toolName) !== undefined
}

export function getRegisteredRendererNames(): string[] {
  return getRegisteredDefinitionNames().filter(hasCustomRenderer)
}
