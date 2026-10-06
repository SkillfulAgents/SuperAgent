// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MarkdownEditor } from './markdown-editor'

// jsdom has no layout; ProseMirror measures the selection after each edit.
Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList
Range.prototype.getBoundingClientRect ??= () => new DOMRect()
document.elementFromPoint ??= () => null

const PROMPT = `# Agent Instructions

<rules>
- Be brief.
</rules>
`

describe('MarkdownEditor', () => {
  it('renders markdown without reporting a change on mount', async () => {
    const onChange = vi.fn()
    render(<MarkdownEditor value={PROMPT} onChange={onChange} />)

    expect(await screen.findByRole('heading', { name: 'Agent Instructions' })).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports markdown that keeps raw XML tags after an edit', async () => {
    const onChange = vi.fn()
    render(<MarkdownEditor value={PROMPT} onChange={onChange} />)

    const heading = await screen.findByRole('heading', { name: 'Agent Instructions' })
    await userEvent.type(heading, 'Draft ')

    expect(onChange).toHaveBeenCalled()
    const markdown = onChange.mock.lastCall![0] as string
    expect(markdown).toMatch(/^# .*Draft.*Agent Instructions/)
    expect(markdown).toContain('<rules>\n- Be brief.\n</rules>')
  })

  it('is not editable when read-only', async () => {
    render(<MarkdownEditor value={PROMPT} readOnly />)

    await screen.findByRole('heading', { name: 'Agent Instructions' })
    expect(document.querySelector('.ProseMirror')?.getAttribute('contenteditable')).toBe('false')
  })
})
