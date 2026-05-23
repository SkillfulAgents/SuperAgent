export type ListAvailableChatProvidersInput = Record<string, never>
export type ListChatIntegrationsInput = Record<string, never>

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
  iconName: 'MessageCircle',
  parseInput: (i: unknown) => asObj<ListAvailableChatProvidersInput>(i),
  getSummary: () => 'List supported chat providers',
} as const

export const listChatIntegrationsDef = {
  displayName: 'List Chat Integrations',
  iconName: 'MessageSquare',
  parseInput: (i: unknown) => asObj<ListChatIntegrationsInput>(i),
  getSummary: () => 'List configured chat integrations',
} as const

export const addChatIntegrationDef = {
  displayName: 'Add Chat Integration',
  iconName: 'Plus',
  parseInput: (i: unknown) => asObj<AddChatIntegrationInput>(i),
  getSummary: (i: unknown) => {
    const { provider, name } = asObj<AddChatIntegrationInput>(i)
    if (name) return `Add ${provider || 'chat'}: ${name}`
    return provider ? `Add ${provider} integration` : 'Add chat integration'
  },
} as const

export const sendChatMessageDef = {
  displayName: 'Send Chat Message',
  iconName: 'Send',
  parseInput: (i: unknown) => asObj<SendChatMessageInput>(i),
  getSummary: (i: unknown) => {
    const { message } = asObj<SendChatMessageInput>(i)
    const preview = truncate(message, 50)
    return preview ? `Send: ${preview}` : 'Send chat message'
  },
} as const

