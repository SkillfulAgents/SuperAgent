import type { ApiMessage, ApiToolCall, ApiCompactBoundary } from '@shared/lib/types/api'

let nextId = 1

function uniqueId(prefix = 'id') {
  return `${prefix}-${nextId++}`
}

export function createUserMessage(overrides: Partial<ApiMessage> = {}): ApiMessage {
  return {
    id: uniqueId('msg'),
    type: 'user',
    content: { text: 'Hello' },
    toolCalls: [],
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  }
}

export function createAssistantMessage(overrides: Partial<ApiMessage> = {}): ApiMessage {
  return {
    id: uniqueId('msg'),
    type: 'assistant',
    content: { text: 'Hi there!' },
    toolCalls: [],
    createdAt: new Date('2025-01-01T00:00:01Z'),
    ...overrides,
  }
}

export function createToolCall(overrides: Partial<ApiToolCall> = {}): ApiToolCall {
  return {
    id: uniqueId('tc'),
    name: 'Bash',
    input: { command: 'echo hello' },
    result: 'hello\n',
    ...overrides,
  }
}

export function createCompactBoundary(overrides: Partial<ApiCompactBoundary> = {}): ApiCompactBoundary {
  return {
    id: uniqueId('cb'),
    type: 'compact_boundary',
    summary: 'Previous conversation was compacted.',
    trigger: 'auto',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  }
}

export function createConversation(turns: number = 2) {
  const messages: ApiMessage[] = []
  for (let i = 0; i < turns; i++) {
    const time = new Date(Date.UTC(2025, 0, 1, 0, i * 2, 0))
    messages.push(
      createUserMessage({
        content: { text: `User message ${i + 1}` },
        createdAt: time,
      })
    )
    messages.push(
      createAssistantMessage({
        content: { text: `Assistant response ${i + 1}` },
        createdAt: new Date(time.getTime() + 60_000),
      })
    )
  }
  return messages
}

export function resetFactoryIds() {
  nextId = 1
}
