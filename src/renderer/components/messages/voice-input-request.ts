import type { VoiceInputRequest } from '@renderer/lib/voice/contracts/conversation'
import type { PendingRequestDescriptor } from './use-pending-requests'

/** Use the displayed cards, including recovered requests, without forwarding raw tool inputs. */
export function describeVoiceInputRequest(request: PendingRequestDescriptor): VoiceInputRequest {
  return { id: `${request.kind}:${request.key}`, message: requestMessage(request).slice(0, 2000) }
}

function requestMessage(request: PendingRequestDescriptor): string {
  switch (request.kind) {
    case 'question':
      return `The agent needs answers in the question card: ${request.questions.map(q => q.question).join(' ')}`
    case 'browser_input':
      return `The agent needs the user to complete an action in the browser: ${request.message}${request.requirements.length ? ` Requirements: ${request.requirements.join(', ')}.` : ''}`
    case 'secret':
      return `The agent needs the secret ${request.secretName} entered securely in the application's secret card.${request.reason ? ` Reason: ${request.reason}` : ''}`
    case 'connected_account':
      return `The agent needs the user to select or connect a ${request.toolkit} account in the application's connection card.${request.reason ? ` Reason: ${request.reason}` : ''}`
    case 'file':
      return `The agent needs a file uploaded through the application's file card: ${request.description}`
    case 'remote_mcp':
      return `The agent needs the user to connect ${request.name || 'an MCP server'} through the application's connection card.${request.reason ? ` Reason: ${request.reason}` : ''}`
    case 'script_run':
      return `The agent needs approval in the application's script card: ${request.explanation}`
    case 'computer_use':
      return `The agent needs approval to use ${request.appName || 'the computer'} in the application's permission card.`
    case 'capability_review':
      return `The agent needs approval to use ${request.capability} in the application's approval card.`
    case 'proxy_review':
      return `The agent needs the user to review a ${request.toolkit} action in the application's approval card.`
    case 'x_agent_review':
      return 'The agent needs the user to review an interaction with another agent in the application.'
    case 'account_reauth_required':
      return `The agent needs the user to reconnect a ${request.toolkit} account in the application.`
    case 'mcp_reauth_required':
      return `The agent needs the user to reconnect ${request.mcpName} in the application.`
  }
}
