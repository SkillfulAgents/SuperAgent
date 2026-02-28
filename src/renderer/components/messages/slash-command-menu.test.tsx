// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SlashCommandMenu } from './slash-command-menu'
import type { SlashCommandInfo } from '@shared/lib/container/types'

beforeAll(() => {
  // jsdom doesn't implement scrollIntoView
  Element.prototype.scrollIntoView = vi.fn()
})

const commands: SlashCommandInfo[] = [
  { name: 'deploy', description: 'Deploy the app', argumentHint: '<env>' },
  { name: 'status', description: 'Show status', argumentHint: '' },
  { name: 'debug', description: '', argumentHint: '' },
]

describe('SlashCommandMenu', () => {
  it('returns null when visible=false', () => {
    const { container } = render(
      <SlashCommandMenu
        commands={commands}
        selectedIndex={0}
        onSelect={vi.fn()}
        visible={false}
        filter=""
      />
    )
    expect(container.innerHTML).toBe('')
  })

  it('returns null when commands are empty', () => {
    const { container } = render(
      <SlashCommandMenu
        commands={[]}
        selectedIndex={0}
        onSelect={vi.fn()}
        visible={true}
        filter=""
      />
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders command names with slash prefix', () => {
    render(
      <SlashCommandMenu
        commands={commands}
        selectedIndex={0}
        onSelect={vi.fn()}
        visible={true}
        filter=""
      />
    )
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0].textContent).toContain('deploy')
    expect(options[1].textContent).toContain('status')
    expect(options[2].textContent).toContain('debug')
  })

  it('renders descriptions', () => {
    render(
      <SlashCommandMenu
        commands={commands}
        selectedIndex={0}
        onSelect={vi.fn()}
        visible={true}
        filter=""
      />
    )
    expect(screen.getByText('Deploy the app')).toBeInTheDocument()
    expect(screen.getByText('Show status')).toBeInTheDocument()
  })

  it('renders argument hints', () => {
    render(
      <SlashCommandMenu
        commands={commands}
        selectedIndex={0}
        onSelect={vi.fn()}
        visible={true}
        filter=""
      />
    )
    expect(screen.getByText('<env>')).toBeInTheDocument()
  })

  it('marks selected index with aria-selected', () => {
    render(
      <SlashCommandMenu
        commands={commands}
        selectedIndex={1}
        onSelect={vi.fn()}
        visible={true}
        filter=""
      />
    )
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[2]).toHaveAttribute('aria-selected', 'false')
  })

  it('calls onSelect on mouseDown', () => {
    const onSelect = vi.fn()
    render(
      <SlashCommandMenu
        commands={commands}
        selectedIndex={0}
        onSelect={onSelect}
        visible={true}
        filter=""
      />
    )
    const options = screen.getAllByRole('option')
    options[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(onSelect).toHaveBeenCalledWith('status')
  })

  it('highlights matching filter in command names', () => {
    render(
      <SlashCommandMenu
        commands={commands}
        selectedIndex={0}
        onSelect={vi.fn()}
        visible={true}
        filter="de"
      />
    )
    // "de" should be bold in "deploy" and "debug"
    const boldElements = document.querySelectorAll('.font-bold')
    expect(boldElements.length).toBeGreaterThanOrEqual(2)
    expect(boldElements[0].textContent).toBe('de')
  })

  it('has listbox role', () => {
    render(
      <SlashCommandMenu
        commands={commands}
        selectedIndex={0}
        onSelect={vi.fn()}
        visible={true}
        filter=""
      />
    )
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })
})
