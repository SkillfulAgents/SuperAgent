import { defineToolRenderer } from '../renderer-types'
import { MessageCircle, Plus, Send } from 'lucide-react'
import type { ToolRendererProps } from '../renderer-types'
import { ResultBlock } from '../ui/shared'
import {
  listAvailableChatProvidersDef,
  listAgentIntegrationsDef,
  addChatIntegrationDef,
  sendChatMessageDef,
  type AddChatIntegrationInput,
  type SendChatMessageInput,
} from './definition'

function ProviderBadge({ provider }: { provider?: string }) {
  if (!provider) return null
  return (
    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
      {provider}
    </span>
  )
}

// ── list_available_chat_providers ────────────────────────────

function ListChatProvidersExpandedView({ result, isError }: ToolRendererProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Querying available chat providers.</p>
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const listChatProvidersRenderer = defineToolRenderer(listAvailableChatProvidersDef, {
  icon: MessageCircle,
  ExpandedView: ListChatProvidersExpandedView,
})

// ── list_agent_integrations ──────────────────────────────────

function ListAgentIntegrationsExpandedView({ result, isError }: ToolRendererProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Listing configured agent integrations.</p>
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const listAgentIntegrationsRenderer = defineToolRenderer(listAgentIntegrationsDef, {
  icon: MessageCircle,
  ExpandedView: ListAgentIntegrationsExpandedView,
})

// ── add_chat_integration ────────────────────────────────────

function AddChatIntegrationExpandedView({ input, result, isError }: ToolRendererProps) {
  const { provider, name } = input as AddChatIntegrationInput
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <ProviderBadge provider={provider} />
        {name && <span className="font-medium">{name}</span>}
      </div>
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const addChatIntegrationRenderer = defineToolRenderer(addChatIntegrationDef, {
  icon: Plus,
  ExpandedView: AddChatIntegrationExpandedView,
})

// ── send_chat_message ───────────────────────────────────────

function SendChatMessageExpandedView({ input, result, isError }: ToolRendererProps) {
  const { message, chat_id } = input as SendChatMessageInput
  return (
    <div className="space-y-2">
      {chat_id && (
        <div className="text-xs">
          <span className="text-muted-foreground">To:</span>{' '}
          <code className="rounded bg-background px-1.5 py-0.5 text-xs">{chat_id}</code>
        </div>
      )}
      {message && (
        <div className="rounded border border-dashed border-border bg-background p-3 text-xs whitespace-pre-wrap">
          {message}
        </div>
      )}
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const sendChatMessageRenderer = defineToolRenderer(sendChatMessageDef, {
  icon: Send,
  ExpandedView: SendChatMessageExpandedView,
})
