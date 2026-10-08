// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownRenderer } from './markdown-renderer'

const text = [
  '```mermaid\ngraph LR\n  Request --> Response\n```',
  '```math\nE = mc^2\n```',
  '```ts\nconst answer = 42\n```',
  '![chart](file:///workspace/out/chart.png)',
].join('\n\n')

vi.mock('./use-file-content', () => ({
  useFileContent: () => ({ data: { text, truncated: false }, isLoading: false, error: null }),
}))

vi.mock('../comments/use-text-selection', () => ({
  useTextSelection: () => ({ selection: null, clearSelection: vi.fn() }),
}))

describe('MarkdownRenderer', () => {
  it('draws mermaid and math fences, keeps other fences as copyable code, and resolves workspace images', async () => {
    const { container } = render(<MarkdownRenderer url="/doc.md" filePath="/doc.md" agentSlug="test-agent" />)

    expect(await screen.findByTestId('mermaid-diagram')).toBeInTheDocument()
    expect(await screen.findByTestId('math-block')).toBeInTheDocument()
    const code = container.querySelector('pre')
    expect(code).toHaveTextContent('const answer = 42')
    expect(code?.querySelector('button')).not.toBeNull()
    expect(screen.getByRole('img', { name: 'chart' }).getAttribute('src')).toContain('test-agent')
  })
})
