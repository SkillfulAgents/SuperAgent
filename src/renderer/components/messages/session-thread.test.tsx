// @vitest-environment jsdom
import { act, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@renderer/test/test-utils'
import { SessionThread } from './session-thread'

let footerHeight = 0
let resizeCallback: ResizeObserverCallback | undefined

vi.mock('@renderer/components/messages/message-list', () => ({
  MessageList: ({ bottomInset }: { bottomInset?: number }) => (
    <div data-testid="message-list" data-bottom-inset={bottomInset} />
  ),
}))

vi.mock('@renderer/components/messages/agent-activity-indicator', () => ({
  AgentActivityIndicator: () => <div data-testid="activity-indicator" />,
}))

const mockStreamState = vi.hoisted(() => ({
  error: null as string | null,
  apiErrorCode: null as string | null,
  errorPresentation: null as { paywall?: object } | null,
}))

// SessionThread reads the error state to swap the composer for the paywall
// card; jsdom has no EventSource, so stub the stream with a quiet session.
vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => mockStreamState,
}))

vi.mock('@renderer/components/tray/tray-manager', () => ({
  TrayManager: () => null,
}))

describe('SessionThread footer layout', () => {
  beforeEach(() => {
    mockStreamState.error = null
    mockStreamState.apiErrorCode = null
    mockStreamState.errorPresentation = null
    footerHeight = 180
    resizeCallback = undefined
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.hasAttribute('data-composer-footer') ? footerHeight : 0
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 0,
        bottom: height,
        left: 0,
        width: 0,
        height,
        toJSON: () => ({}),
      }
    })
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('overlays the footer and keeps measured clearance beneath the live edge', () => {
    renderWithProviders(
      <SessionThread
        sessionId="s-1"
        agentSlug="agent-1"
        footer={<div>Composer</div>}
        overlayFooter
      />,
    )

    expect(screen.getByTestId('session-thread-main')).toHaveClass('relative', 'flex')
    expect(screen.getByText('Composer').parentElement).toHaveAttribute('data-overlay-footer', 'true')
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-bottom-inset', '180')

    footerHeight = 240
    act(() => resizeCallback?.([], {} as ResizeObserver))
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-bottom-inset', '240')
  })

  it('keeps the shared read-only layout in normal document flow by default', () => {
    renderWithProviders(
      <SessionThread
        sessionId="s-1"
        agentSlug="agent-1"
        footer={<div>Read-only footer</div>}
      />,
    )

    expect(screen.getByTestId('session-thread-main')).toHaveClass('grid', 'grid-rows-[1fr_auto]')
    expect(screen.getByText('Read-only footer').parentElement).not.toHaveAttribute('data-overlay-footer')
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-bottom-inset', '0')
  })

  it('hides the composer only when the server authored a paywall', () => {
    mockStreamState.error = 'API Error: 402 Workspace has insufficient balance. Top up to continue.'
    mockStreamState.apiErrorCode = 'unknown'
    mockStreamState.errorPresentation = { paywall: {} }
    renderWithProviders(
      <SessionThread
        sessionId="s-1"
        agentSlug="agent-1"
        footer={<div>Composer</div>}
        overlayFooter
      />,
    )
    expect(screen.queryByText('Composer')).not.toBeInTheDocument()
  })

  it('keeps the composer for an unknown 402 without a server paywall', () => {
    mockStreamState.error = 'API Error: 402 Workspace has insufficient balance. Top up to continue.'
    mockStreamState.apiErrorCode = 'unknown'
    renderWithProviders(
      <SessionThread
        sessionId="s-1"
        agentSlug="agent-1"
        footer={<div>Composer</div>}
        overlayFooter
      />,
    )
    expect(screen.getByText('Composer')).toBeInTheDocument()
  })
})
