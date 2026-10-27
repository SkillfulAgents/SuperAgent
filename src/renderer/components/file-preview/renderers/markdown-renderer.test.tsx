// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '@renderer/components/messages/agent-markdown'
import { resolveAnchor } from '../comments/anchor'
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
  beforeEach(() => { comments.length = 0 })

  it('folds the frontmatter into a closed Properties row and draws only what follows', () => {
    text = '---\ntitle: Overview\n---\n# Overview'
    render(<MarkdownRenderer url="/doc.md" filePath="/doc.md" agentSlug="test-agent" />)
    expect(screen.getByTestId('markdown-frontmatter')).not.toHaveAttribute('open')
    expect(screen.getByText('title: Overview')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /title:/ })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Overview' })).toHaveAttribute('data-comment-lines', '4-4')
  })

  it.each(['\n', '\r\n'])('resolves individual frontmatter lines for hover comments with %j line endings', (newline) => {
    text = ['---', '# exported', '', 'title: Overview', 'owner: Ada', '---', '# Overview'].join(newline)
    render(<MarkdownRenderer url="/doc.md" filePath="/doc.md" agentSlug="test-agent" />)
    fireEvent.click(screen.getByText('Properties'))
    expect(screen.getByTestId('markdown-frontmatter')).toHaveAttribute('open')
    const surface = { text: { blocks: { current: screen.getByTestId('markdown-renderer') } } }

    for (const [quote, line] of [['title: Overview', 4], ['owner: Ada', 5]] as const) {
      expect(resolveAnchor(surface, { on: 'mouse', target: screen.getByText(quote), clientX: 0, clientY: 0 })).toEqual({
        kind: 'text', quote, lines: { start: line, end: line },
      })
    }
    expect(screen.getByRole('heading', { name: 'Overview' })).toHaveAttribute('data-comment-lines', '7-7')
  })

  it('includes frontmatter source lines in selections within metadata and across the body', () => {
    text = '---\ntitle: Overview\nowner: Ada\n---\n# Overview'
    render(<MarkdownRenderer url="/doc.md" filePath="/doc.md" agentSlug="test-agent" />)
    fireEvent.click(screen.getByText('Properties'))
    const surface = { text: { blocks: { current: screen.getByTestId('markdown-renderer') } } }
    const range = document.createRange()
    range.selectNodeContents(screen.getByText('owner: Ada'))

    expect(resolveAnchor(surface, { on: 'selection', range, text: range.toString() })).toEqual({
      kind: 'text', quote: 'owner: Ada', lines: { start: 3, end: 3 },
    })

    range.setStart(screen.getByText('title: Overview').firstChild!, 0)
    const heading = screen.getByRole('heading', { name: 'Overview' })
    range.setEnd(heading, heading.childNodes.length)
    expect(resolveAnchor(surface, { on: 'selection', range, text: range.toString() })).toMatchObject({
      kind: 'text', lines: { start: 2, end: 5 },
    })
  })

  it('keeps a frontmatter comment pin through expansion and file refresh, and removes it cleanly', () => {
    text = '---\ntitle: Overview\nowner: Ada\n---\n# Overview'
    // Before folding, Markdown rendered the metadata and closing delimiter as a heading on lines 2–4.
    comments.push({ anchor: { kind: 'text', quote: 'title: Overview\nowner: Ada', lines: { start: 2, end: 4 } } })
    const view = render(<MarkdownRenderer url="/doc.md" filePath="/doc.md" agentSlug="test-agent" />)
    fireEvent.click(screen.getByText('Properties'))
    const pinAt = (quote: string) => screen.getByText(quote).closest('[data-comment-lines]')?.querySelector('[data-comment-marker]')
    expect(pinAt('title: Overview')).toHaveTextContent('1')

    text = '---\ntitle: Updated overview\nowner: Ada\n---\n# Overview'
    view.rerender(<MarkdownRenderer url="/doc.md" filePath="/doc.md" agentSlug="test-agent" />)
    expect(pinAt('title: Updated overview')).toHaveTextContent('1')

    comments.length = 0
    expect(() => view.rerender(<MarkdownRenderer url="/doc.md" filePath="/doc.md" agentSlug="test-agent" />)).not.toThrow()
    expect(screen.getByTestId('markdown-frontmatter').querySelector('[data-comment-marker]')).toBeNull()
  })

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

    expect(screen.queryByTestId('markdown-frontmatter')).toBeNull()
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
