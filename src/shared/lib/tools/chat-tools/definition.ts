export type ListAvailableChatProvidersInput = Record<string, never>
export type ListAgentIntegrationsInput = Record<string, never>

export interface AddChatIntegrationInput {
  provider?: string
  config?: Record<string, unknown>
  name?: string
}

export interface SendChatMessageInput {
  integration_id?: string
  message?: string
  chat_id?: string
  context?: string
}

function asObj<T>(input: unknown): T {
  return typeof input === 'object' && input !== null ? (input as T) : ({} as T)
}

function truncate(s: string | undefined, max = 80): string | null {
  if (!s) return null
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export const listAvailableChatProvidersDef = {
  displayName: 'List Chat Providers',
  parseInput: (i: unknown) => asObj<ListAvailableChatProvidersInput>(i),
  getSummary: () => 'List supported chat providers',
} as const

export const listAgentIntegrationsDef = {
  displayName: 'List Add-ons',
  parseInput: (i: unknown) => asObj<ListAgentIntegrationsInput>(i),
  getSummary: () => 'List configured add-ons',
} as const

export const addChatIntegrationDef = {
  displayName: 'New Chat Add-on',
  parseInput: (i: unknown) => asObj<AddChatIntegrationInput>(i),
  getSummary: (i: unknown) => {
    const { provider, name } = asObj<AddChatIntegrationInput>(i)
    if (name) return `New ${provider || 'chat'} add-on: ${name}`
    return provider ? `New ${provider} add-on` : 'New chat add-on'
  },
} as const

export const sendChatMessageDef = {
  displayName: 'Send Chat Message',
  parseInput: (i: unknown) => asObj<SendChatMessageInput>(i),
  getSummary: (i: unknown) => {
    const { message } = asObj<SendChatMessageInput>(i)
    const preview = truncate(message, 50)
    return preview ? `Send: ${preview}` : 'Send chat message'
  },
} as const

