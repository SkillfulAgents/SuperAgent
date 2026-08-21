// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ThinkingBlockItem } from './thinking-block-item'

describe('ThinkingBlockItem Markdown', () => {
  afterEach(cleanup)

  it('renders GitHub-flavored Markdown instead of showing its source syntax', () => {
    render(
      <ThinkingBlockItem
        active
        text={[
          '**Considering implementation steps**',
          '',
          '- Inspect `input`',
          '- Choose ~~the first~~ a safe approach',
          '',
          '| Item | Status |',
          '| --- | --- |',
          '| Parser | Ready |',
        ].join('\n')}
      />
    )

    const heading = screen.getByText('Considering implementation steps')
    expect(heading.tagName).toBe('STRONG')
    expect(screen.queryByText('**Considering implementation steps**')).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('input').tagName).toBe('CODE')
    expect(screen.getByText('the first').tagName).toBe('DEL')
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('uses the shared safe URL policy for links in reasoning text', () => {
    render(
      <ThinkingBlockItem
        active={false}
        text="[Docs](https://example.com) [Phone](tel:+15551234567) [Bad](javascript:alert(1))"
      />
    )
    fireEvent.click(screen.getByTestId('thinking-block-toggle'))

    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', 'https://example.com')
    expect(screen.getByRole('link', { name: 'Phone' })).toHaveAttribute('href', 'tel:+15551234567')
    // An anchor with a blanked href intentionally has no accessible `link`
    // role, so inspect the rendered element directly.
    expect(screen.getByText('Bad').closest('a')).toHaveAttribute('href', '')
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('target', '_blank')
  })
})
