// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BrowserToolbar } from './browser-toolbar'

const props = {
  url: 'https://example.test/current',
  canGoBack: true,
  canGoForward: true,
  connected: true,
  isViewOnly: false,
  loading: false,
  needsAttention: false,
}

describe('BrowserToolbar', () => {
  it('sends the selected navigation command and displays the current URL', () => {
    const onNavigate = vi.fn()
    render(<BrowserToolbar {...props} onNavigate={onNavigate} />)
    for (const label of ['Back', 'Forward', 'Reload']) fireEvent.click(screen.getByRole('button', { name: label }))
    expect(onNavigate.mock.calls).toEqual([['back'], ['forward'], ['reload']])
    expect(screen.getByTestId('browser-tray-url')).toHaveTextContent(props.url)
  })

  it.each([
    { connected: false, isViewOnly: false },
    { connected: true, isViewOnly: true },
  ])('disables navigation when control is unavailable: %j', (state) => {
    const onNavigate = vi.fn()
    render(<BrowserToolbar {...props} {...state} onNavigate={onNavigate} />)
    for (const label of ['Back', 'Forward', 'Reload']) {
      const button = screen.getByRole('button', { name: label })
      expect(button).toBeDisabled()
      fireEvent.click(button)
    }
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('disables unavailable history directions while allowing reload', () => {
    render(<BrowserToolbar {...props} canGoBack={false} canGoForward={false} onNavigate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled()
  })
})
