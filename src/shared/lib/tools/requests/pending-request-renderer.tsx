import type { ComponentType, ReactElement } from 'react'
import type { PendingRequestDescriptor } from './types'
import { SecretRequestItem } from '../request-secret/request'
import { ConnectedAccountRequestItem } from '../request-connected-account/request'
import { RemoteMcpRequestItem } from '../request-remote-mcp/request'
import { QuestionRequestItem } from '../ask-user-question/request'
import { FileRequestItem } from '../request-file/request'
import { BrowserInputRequestItem } from '../request-browser-input/request'
import { ScriptRunRequestItem } from '../request-script-run/request'
import { ComputerUseRequestItem } from '../computer-use/request'
import { CapabilityReviewRequestItem } from '../capability-review/request'
import { ProxyReviewRequestItem } from '../proxy-review/request'
import { XAgentReviewRequestItem } from '../x-agent-review/request'
import { AccountReauthRequestItem } from '../account-reauth/request'
import { McpReauthRequestItem } from '../mcp-reauth/request'

export interface RenderContext {
  sessionId: string
  agentSlug: string
  readOnly: boolean
}

type RequestProps<K extends PendingRequestDescriptor['kind']> =
  Omit<Extract<PendingRequestDescriptor, { kind: K }>, 'kind' | 'key'> & RenderContext

const requestRenderers = {
  secret: SecretRequestItem,
  connected_account: ConnectedAccountRequestItem,
  remote_mcp: RemoteMcpRequestItem,
  question: QuestionRequestItem,
  file: FileRequestItem,
  browser_input: BrowserInputRequestItem,
  script_run: ScriptRunRequestItem,
  computer_use: ComputerUseRequestItem,
  capability_review: CapabilityReviewRequestItem,
  proxy_review: ProxyReviewRequestItem,
  x_agent_review: XAgentReviewRequestItem,
  account_reauth_required: AccountReauthRequestItem,
  mcp_reauth_required: McpReauthRequestItem,
} satisfies { [K in PendingRequestDescriptor['kind']]: ComponentType<RequestProps<K>> }

export function renderPendingRequest(d: PendingRequestDescriptor, ctx: RenderContext): ReactElement {
  const { kind, key, ...props } = d
  // The mapped type above checks each binding. This assertion preserves the
  // kind/props correlation after indexing a heterogeneous component map.
  const Request = requestRenderers[kind] as ComponentType<typeof props & RenderContext>
  return <Request key={key} {...props} {...ctx} />
}
