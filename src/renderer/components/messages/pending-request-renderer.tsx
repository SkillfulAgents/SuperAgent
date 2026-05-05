import type { ReactElement } from 'react'
import { SecretRequestItem } from './secret-request-item'
import { ConnectedAccountRequestItem } from './connected-account-request-item'
import { RemoteMcpRequestItem } from './remote-mcp-request-item'
import { QuestionRequestItem } from './question-request-item'
import { FileRequestItem } from './file-request-item'
import { BrowserInputRequestItem } from './browser-input-request-item'
import { ScriptRunRequestItem } from './script-run-request-item'
import { ComputerUseRequestItem } from './computer-use-request-item'
import { ProxyReviewRequestItem } from './proxy-review-request-item'
import { XAgentReviewRequestItem } from './x-agent-review-request-item'
import type { PendingRequestDescriptor } from './use-pending-requests'

export interface RenderContext {
  sessionId: string
  agentSlug: string
  readOnly: boolean
}

export function renderPendingRequest(
  d: PendingRequestDescriptor,
  ctx: RenderContext,
): ReactElement {
  switch (d.kind) {
    case 'secret':
      return (
        <SecretRequestItem
          key={d.key}
          toolUseId={d.toolUseId}
          secretName={d.secretName}
          reason={d.reason}
          sessionId={ctx.sessionId}
          agentSlug={ctx.agentSlug}
          readOnly={ctx.readOnly}
          onComplete={d.onComplete}
        />
      )
    case 'connected_account':
      return (
        <ConnectedAccountRequestItem
          key={d.key}
          toolUseId={d.toolUseId}
          toolkit={d.toolkit}
          reason={d.reason}
          sessionId={ctx.sessionId}
          agentSlug={ctx.agentSlug}
          readOnly={ctx.readOnly}
          onComplete={d.onComplete}
        />
      )
    case 'remote_mcp':
      return (
        <RemoteMcpRequestItem
          key={d.key}
          toolUseId={d.toolUseId}
          url={d.url}
          name={d.name}
          reason={d.reason}
          authHint={d.authHint}
          sessionId={ctx.sessionId}
          agentSlug={ctx.agentSlug}
          readOnly={ctx.readOnly}
          onComplete={d.onComplete}
        />
      )
    case 'question':
      return (
        <QuestionRequestItem
          key={d.key}
          toolUseId={d.toolUseId}
          questions={d.questions}
          sessionId={ctx.sessionId}
          agentSlug={ctx.agentSlug}
          readOnly={ctx.readOnly}
          onComplete={d.onComplete}
        />
      )
    case 'file':
      return (
        <FileRequestItem
          key={d.key}
          toolUseId={d.toolUseId}
          description={d.description}
          fileTypes={d.fileTypes}
          sessionId={ctx.sessionId}
          agentSlug={ctx.agentSlug}
          readOnly={ctx.readOnly}
          onComplete={d.onComplete}
        />
      )
    case 'browser_input':
      return (
        <BrowserInputRequestItem
          key={d.key}
          toolUseId={d.toolUseId}
          message={d.message}
          requirements={d.requirements}
          sessionId={ctx.sessionId}
          agentSlug={ctx.agentSlug}
          readOnly={ctx.readOnly}
          onComplete={d.onComplete}
        />
      )
    case 'script_run':
      return (
        <ScriptRunRequestItem
          key={d.key}
          toolUseId={d.toolUseId}
          script={d.script}
          explanation={d.explanation}
          scriptType={d.scriptType}
          sessionId={ctx.sessionId}
          agentSlug={ctx.agentSlug}
          readOnly={ctx.readOnly}
          onComplete={d.onComplete}
        />
      )
    case 'computer_use':
      return (
        <ComputerUseRequestItem
          key={d.key}
          toolUseId={d.toolUseId}
          method={d.method}
          params={d.params}
          permissionLevel={d.permissionLevel}
          appName={d.appName}
          sessionId={ctx.sessionId}
          agentSlug={ctx.agentSlug}
          readOnly={ctx.readOnly}
          onComplete={d.onComplete}
        />
      )
    case 'proxy_review':
      return (
        <ProxyReviewRequestItem
          key={d.key}
          reviewId={d.reviewId}
          accountId={d.accountId}
          toolkit={d.toolkit}
          method={d.method}
          targetPath={d.targetPath}
          matchedScopes={d.matchedScopes}
          scopeDescriptions={d.scopeDescriptions}
          displayText={d.displayText}
          agentSlug={ctx.agentSlug}
          readOnly={ctx.readOnly}
          onComplete={d.onComplete}
        />
      )
    case 'x_agent_review':
      return (
        <XAgentReviewRequestItem
          key={d.key}
          reviewId={d.reviewId}
          agentSlug={ctx.agentSlug}
          xAgent={d.xAgent}
          readOnly={ctx.readOnly}
          onComplete={d.onComplete}
        />
      )
  }
}
