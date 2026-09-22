import { describe, expect, it } from 'vitest'
import { downloadAgentFileDef, invokeAgentDef } from './x-agent-tools'

describe('invokeAgentDef', () => {
  it('parses attachments and includes their count in the summary', () => {
    const input = {
      slug: 'reviewer',
      prompt: 'Review these files',
      attachments: ['/workspace/report.pdf', 'notes/context.txt'],
    }

    expect(invokeAgentDef.parseInput(input)).toEqual(input)
    expect(invokeAgentDef.getSummary(input)).toBe('reviewer (new session) [2 files]: Review these files')
  })

  it('ignores malformed fields without throwing', () => {
    expect(invokeAgentDef.parseInput(null)).toEqual({})
    expect(invokeAgentDef.parseInput({ slug: 12, session_id: true, attachments: ['valid', 3] })).toEqual({})
    expect(invokeAgentDef.getSummary({ slug: 12, session_id: true })).toBe('Invoke agent')
  })
})

describe('downloadAgentFileDef', () => {
  const input = {
    slug: 'reviewer',
    session_id: 'session-123456789',
    delivery_id: 'delivery-987654321',
  }

  it('parses identifiers and summarizes the source delivery', () => {
    expect(downloadAgentFileDef.parseInput(input)).toEqual(input)
    expect(downloadAgentFileDef.getSummary(input)).toBe('Download reviewer/session-… · delivery…')
  })

  it('handles unknown input defensively', () => {
    expect(downloadAgentFileDef.parseInput(undefined)).toEqual({})
    expect(downloadAgentFileDef.parseInput({ slug: [], session_id: 1, delivery_id: false })).toEqual({})
    expect(downloadAgentFileDef.getSummary(null)).toBe('Download agent file')
  })
})
