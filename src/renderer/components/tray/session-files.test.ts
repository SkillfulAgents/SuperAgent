import { describe, expect, it } from 'vitest'
import type { ApiMessageOrBoundary, ApiToolCall } from '@shared/lib/types/api'
import { appendAttachedFiles } from '@shared/lib/utils/attached-files'
import { collectSessionFiles } from './session-files'

function turn(...toolCalls: Partial<ApiToolCall>[]): ApiMessageOrBoundary {
  return {
    type: 'assistant',
    id: `m${Math.random()}`,
    content: { text: '' },
    toolCalls: toolCalls.map((call, i) => ({ id: `t${i}${Math.random()}`, input: {}, ...call })),
    createdAt: new Date().toISOString(),
  } as unknown as ApiMessageOrBoundary
}

describe('collectSessionFiles', () => {
  it('lists delivered and written files, most recent first, each once, keeping a delivery note', () => {
    const files = collectSessionFiles([
      turn({ name: 'Write', input: { file_path: '/workspace/a.md' } }),
      turn({ name: 'mcp__user-input__deliver_file', input: { filePath: '/workspace/report.md', description: 'The report' }, result: 'ok' }),
      turn({ name: 'Edit', input: { file_path: '/workspace/a.md' } }),
      turn({ name: 'NotebookEdit', input: { notebook_path: '/workspace/n.ipynb' } }),
    ])
    expect(files).toEqual([
      { filePath: '/workspace/n.ipynb', description: undefined },
      { filePath: '/workspace/a.md', description: undefined },
      { filePath: '/workspace/report.md', description: 'The report' },
    ])
  })

  it('lists the person\'s uploads too, marked, at their latest touch', () => {
    const upload = {
      type: 'user',
      id: 'u1',
      content: { text: appendAttachedFiles('Have a look', ['/workspace/uploads/sheet.xlsx']) },
      createdAt: new Date().toISOString(),
    } as unknown as ApiMessageOrBoundary
    const files = collectSessionFiles([
      upload,
      turn({ name: 'Write', input: { file_path: '/workspace/out.md' } }),
    ])
    expect(files.map(f => f.filePath)).toContain('/workspace/uploads/sheet.xlsx')
    expect(files.find(f => f.filePath === '/workspace/uploads/sheet.xlsx')?.uploaded).toBe(true)
    expect(files.find(f => f.filePath === '/workspace/out.md')?.uploaded).toBeUndefined()
    expect(files[0].filePath).toBe('/workspace/out.md')
  })

  it('leaves out failed calls and tools that touch no file', () => {
    expect(collectSessionFiles([
      turn({ name: 'Write', input: { file_path: '/workspace/x.md' }, isError: true }),
      turn({ name: 'Bash', input: { command: 'ls' } }),
    ])).toEqual([])
    expect(collectSessionFiles(undefined)).toEqual([])
  })
})
