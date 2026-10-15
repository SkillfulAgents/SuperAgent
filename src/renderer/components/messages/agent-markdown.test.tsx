// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from './agent-markdown'

const { parsed } = vi.hoisted(() => ({ parsed: [] as string[] }))

vi.mock('@renderer/components/ui/markdown', () => ({
  Markdown: ({ children }: { children: string }) => {
    parsed.push(children)
    return <p>{children}</p>
  },
  MarkdownLink: () => null,
}))

function Streamed({ tail }: { tail: string }) {
  return (
    <>
      <AgentMarkdown text="Settled block." mode="settled" agentSlug="agent" />
      <AgentMarkdown text={tail} mode="streaming" agentSlug="agent" />
    </>
  )
}

describe('AgentMarkdown', () => {
  it('parses a settled block once while the tail keeps growing', () => {
    const { rerender } = render(<Streamed tail="Grow" />)
    rerender(<Streamed tail="Growing" />)
    rerender(<Streamed tail="Growing tail" />)

    expect(parsed.filter(text => text === 'Settled block.')).toHaveLength(1)
    expect(parsed.filter(text => text !== 'Settled block.')).toEqual(['Grow', 'Growing', 'Growing tail'])
  })
})
