import { MessageCircle, Plus, Send } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps } from './types'
import {
  listAvailableChatProvidersDef,
  listChatIntegrationsDef,
  addChatIntegrationDef,
  sendChatMessageDef,
  type AddChatIntegrationInput,
  type SendChatMessageInput,
} from '@shared/lib/tool-definitions/chat-tools'

function ResultBlock({ result, isError }: { result?: string | null; isError?: boolean }) {
  if (!result) return null
  return (
    <pre
      className={`whitespace-pre-wrap bg-background rounded p-2 text-xs ${
        isError
          ? 'text-red-800 dark:text-red-200'
          : 'text-foreground/90'
      }`}
    >
      {result}
    </pre>
  )
}

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

export const listChatProvidersRenderer: ToolRenderer = {
  displayName: listAvailableChatProvidersDef.displayName,
  icon: MessageCircle,
  getSummary: listAvailableChatProvidersDef.getSummary,
  ExpandedView: ListChatProvidersExpandedView,
}

// ── list_chat_integrations ──────────────────────────────────

function ListChatIntegrationsExpandedView({ result, isError }: ToolRendererProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Listing configured chat integrations.</p>
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const listChatIntegrationsRenderer: ToolRenderer = {
  displayName: listChatIntegrationsDef.displayName,
  icon: MessageCircle,
  getSummary: listChatIntegrationsDef.getSummary,
  ExpandedView: ListChatIntegrationsExpandedView,
}

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

export const addChatIntegrationRenderer: ToolRenderer = {
  displayName: addChatIntegrationDef.displayName,
  icon: Plus,
  getSummary: addChatIntegrationDef.getSummary,
  ExpandedView: AddChatIntegrationExpandedView,
}

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

export const sendChatMessageRenderer: ToolRenderer = {
  displayName: sendChatMessageDef.displayName,
  icon: Send,
  getSummary: sendChatMessageDef.getSummary,
  ExpandedView: SendChatMessageExpandedView,
}
