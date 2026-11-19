import { describe, it, expect } from 'vitest'
import { createUserMessage, createAssistantMessage, createToolCall } from '@renderer/test/factories'
import { collectDeliveries, collectTurnDeliveredFiles } from './delivered-files'

function delivery(id: string, filePath: string, description?: string) {
  return createToolCall({
    id,
    name: 'mcp__user-input__deliver_file',
    input: { filePath, ...(description ? { description } : {}) },
    result: 'File delivered',
  })
}

describe('collectTurnDeliveredFiles', () => {
  it('lists a file re-delivered in the same turn once, as its latest delivery', () => {
    const files = collectTurnDeliveredFiles([
      createUserMessage({ content: { text: 'Write the roadmap' } }),
      createAssistantMessage({
        toolCalls: [
          delivery('tc-1', '/workspace/roadmap.md', 'Roadmap v0.1'),
          delivery('tc-2', '/workspace/data.csv'),
        ],
      }),
      createAssistantMessage({
        id: 'answer',
        toolCalls: [delivery('tc-3', '/workspace/roadmap.md', 'Roadmap v0.2')],
      }),
    ], true)

    expect(files.get('answer')?.map(({ id, filePath, description }) => ({ id, filePath, description }))).toEqual([
      { id: 'tc-2', filePath: '/workspace/data.csv', description: undefined },
      { id: 'tc-3', filePath: '/workspace/roadmap.md', description: 'Roadmap v0.2' },
    ])
  })

  it('keeps a delivery of the same path in each turn that delivered it', () => {
    const files = collectTurnDeliveredFiles([
      createUserMessage({ content: { text: 'Make a chart' } }),
      createAssistantMessage({ id: 'first', toolCalls: [delivery('tc-1', '/workspace/chart.png')] }),
      createUserMessage({ content: { text: 'Use other colors' } }),
      createAssistantMessage({ id: 'second', toolCalls: [delivery('tc-2', '/workspace/chart.png')] }),
    ], true)

    expect(files.get('first')?.map((file) => file.id)).toEqual(['tc-1'])
    expect(files.get('second')?.map((file) => file.id)).toEqual(['tc-2'])
  })
})

describe('collectDeliveries', () => {
  it('lists every delivery, the running turn\'s too, and leaves out one that failed', () => {
    const deliveries = collectDeliveries([
      createUserMessage({ content: { text: 'Write the roadmap' } }),
      createAssistantMessage({ toolCalls: [delivery('tc-1', '/workspace/roadmap.md')] }),
      createAssistantMessage({
        toolCalls: [
          createToolCall({ id: 'tc-2', name: 'mcp__user-input__deliver_file', input: { filePath: '/workspace/gone.md' }, isError: true }),
          createToolCall({ id: 'tc-3', name: 'Bash', input: { command: 'ls' } }),
          // Still running: no result yet. The file is already written, so it counts.
          createToolCall({ id: 'tc-4', name: 'mcp__user-input__deliver_file', input: { filePath: '/workspace/roadmap.md' }, result: undefined }),
        ],
      }),
    ])

    expect(deliveries.map(({ id, filePath }) => ({ id, filePath }))).toEqual([
      { id: 'tc-1', filePath: '/workspace/roadmap.md' },
      { id: 'tc-4', filePath: '/workspace/roadmap.md' },
    ])
  })
})
