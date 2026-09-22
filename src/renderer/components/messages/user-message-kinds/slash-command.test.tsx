// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SlashCommandBubble } from './slash-command'
import type { ApiMessage } from '@shared/lib/types/api'

const message = { id: 'm1', type: 'user', content: { text: '' } } as unknown as ApiMessage

describe('SlashCommandBubble', () => {
  it('decorates the command name and renders the arguments through the default Markdown body', () => {
    const renderMarkdown = vi.fn((text: string) => <em data-testid="md">{text}</em>)
    render(<SlashCommandBubble text="/deploy **production** now" message={message} renderMarkdown={renderMarkdown} />)

    expect(screen.getByText('/deploy')).toHaveClass('font-mono')
    expect(renderMarkdown).toHaveBeenCalledWith('**production** now')
    expect(screen.getByTestId('md')).toHaveTextContent('**production** now')
  })

  it('renders nothing but the name when there are no arguments', () => {
    const renderMarkdown = vi.fn()
    render(<SlashCommandBubble text="/status" message={message} renderMarkdown={renderMarkdown} />)

    expect(screen.getByText('/status')).toBeInTheDocument()
    expect(renderMarkdown).not.toHaveBeenCalled()
  })
})
