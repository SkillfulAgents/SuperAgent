// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '@renderer/components/messages/agent-markdown'
import { MarkdownRenderer } from './markdown-renderer'

const FENCES = [
  '```mermaid\ngraph LR\n  Request --> Response\n```',
  '```math\nE = mc^2\n```',
  '```ts\nconst answer = 42\n```',
  '![chart](file:///workspace/out/chart.png)',
].join('\n\n')
let text = ''

vi.mock('./use-file-content', () => ({
  useFileContent: () => ({ data: { text, truncated: false }, isLoading: false, error: null }),
}))

const { comments } = vi.hoisted(() => ({ comments: [] as { anchor: unknown }[] }))

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ commentsFor: () => comments, addComment: vi.fn(), commentsEnabled: true }),
}))

describe('MarkdownRenderer', () => {
  it('draws mermaid and math fences, keeps other fences as copyable code, and resolves workspace images', async () => {
    text = FENCES
    const { container } = render(<MarkdownRenderer url="/doc.md" filePath="/doc.md" agentSlug="test-agent" />)

    expect(await screen.findByTestId('mermaid-diagram')).toBeInTheDocument()
    expect(await screen.findByTestId('math-block')).toBeInTheDocument()
    const code = container.querySelector('pre')
    expect(code).toHaveTextContent('const answer = 42')
    expect(code?.querySelector('button')).not.toBeNull()
    expect(screen.getByRole('img', { name: 'chart' }).getAttribute('src')).toContain('test-agent')
  })

  it('stamps every block a comment can point at with its source lines, code blocks and diagrams included', async () => {
    text = '# Title\n\nPara one\n\n- item\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\n\n```mermaid\ngraph LR\n  A --> B\n```'
    render(<MarkdownRenderer url="/doc.md" filePath="/workspace/doc.md" agentSlug="test-agent" />)
    await screen.findByTestId('mermaid-diagram')

    const marked = [...screen.getByTestId('markdown-renderer').querySelectorAll('[data-comment-lines]')]
    expect(marked.map(el => `${el.tagName.toLowerCase()} ${el.getAttribute('data-comment-lines')}`)).toEqual([
      'h1 1-1', 'p 3-3', 'li 5-5', 'th 7-7', 'th 7-7', 'td 9-9', 'td 9-9', 'div 11-13', 'div 15-18',
    ])
  })

  it('leaves chat code blocks bare: only the drawer stamps lines', () => {
    const { container } = render(<AgentMarkdown text={'| a |\n|---|\n| 1 |\n\n```ts\nconst x = 1\n```'} mode="settled" />)

    expect(container.querySelector('[data-comment-lines]')).toBeNull()
    expect(container.querySelector('pre')?.parentElement).toBe(container)
  })

  it('keeps the pin on a paragraph when the file refreshes, and removes it cleanly', () => {
    text = 'Ship it.'
    comments.push({ anchor: { kind: 'text', quote: 'Ship it.', lines: { start: 1, end: 1 } } })
    const view = render(<MarkdownRenderer url="/doc.md" filePath="/workspace/doc.md" agentSlug="test-agent" />)
    expect(screen.getByText('Ship it.').closest('p')).toHaveTextContent('1')

    text = 'Ship it now.'
    view.rerender(<MarkdownRenderer url="/doc.md" filePath="/workspace/doc.md" agentSlug="test-agent" />)
    expect(screen.getByText('Ship it now.').closest('p')).toHaveTextContent('1')

    comments.length = 0
    expect(() => view.rerender(<MarkdownRenderer url="/doc.md" filePath="/workspace/doc.md" agentSlug="test-agent" />)).not.toThrow()
    expect(screen.getByText('Ship it now.').closest('p')).not.toHaveTextContent('1')
  })
})
