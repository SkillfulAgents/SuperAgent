// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'
import { createAssistantMessage, createCompactBoundary, createUserMessage } from '@renderer/test/factories'

import { currentProviderError, ProviderErrorPlacement } from './provider-error-placement'

const mockStreamState = {
  isActive: false,
  error: null as string | null,
  apiErrorCode: null as string | null,
  errorPresentation: null as ProviderErrorPresentation | null,
}
vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => mockStreamState,
}))

const mockMessages: ApiMessageOrBoundary[] = []
vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => ({ data: mockMessages }),
}))

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: { connected: false, platformBaseUrl: null, orgId: null } }),
}))

const composerError: ProviderErrorPresentation = {
  severity: 'warning',
  message: '**Routed:** replaces the composer',
  icon: 'info',
  placement: 'composer',
}
const inlineError: ProviderErrorPresentation = { severity: 'error', message: '**Inline**', icon: 'info' }

const idle = { isActive: false, error: null, apiErrorCode: null, errorPresentation: null }

function errorMessage(presentation?: ProviderErrorPresentation) {
  return createAssistantMessage({
    content: { text: 'API Error: 402 insufficient balance' },
    apiError: 'billing_error',
    errorPresentation: presentation,
  })
}

describe('currentProviderError', () => {
  it('prefers the live error', () => {
    const live = { isActive: false, error: 'live 429', apiErrorCode: 'rate_limit', errorPresentation: composerError }
    expect(currentProviderError(live, [errorMessage(inlineError)])).toEqual({
      message: 'live 429',
      presentation: composerError,
      live: true,
    })
  })

  it('accepts a live error with a generic SDK code when a presentation is attached', () => {
    const live = { isActive: false, error: 'API Error: 402', apiErrorCode: 'unknown', errorPresentation: composerError }
    expect(currentProviderError(live, [])).toEqual({ message: 'API Error: 402', presentation: composerError, live: true })
  })

  it('accepts a persisted error with a generic SDK code when a presentation is attached', () => {
    const msg = createAssistantMessage({ content: { text: 'API Error: 402' }, apiError: 'unknown', errorPresentation: composerError })
    expect(currentProviderError(idle, [msg])).toEqual({ message: 'API Error: 402', presentation: composerError, live: false })
  })

  it('ignores a live error that is not a provider error', () => {
    const live = { isActive: false, error: 'container died', apiErrorCode: null, errorPresentation: null }
    expect(currentProviderError(live, [])).toBeNull()
  })

  it('falls back to the last assistant message when it is a provider error', () => {
    const msg = errorMessage(composerError)
    expect(currentProviderError(idle, [createUserMessage(), msg])).toEqual({
      message: msg.content.text,
      presentation: composerError,
      live: false,
    })
  })

  it('skips compact boundaries and trailing user messages when scanning back', () => {
    const msg = errorMessage(composerError)
    expect(currentProviderError(idle, [msg, createCompactBoundary(), createUserMessage()])).not.toBeNull()
  })

  it('expires once a normal assistant reply follows', () => {
    expect(currentProviderError(idle, [errorMessage(composerError), createUserMessage(), createAssistantMessage()])).toBeNull()
  })

  it('returns null while the agent is working again', () => {
    expect(currentProviderError({ ...idle, isActive: true }, [errorMessage(composerError)])).toBeNull()
  })

  it('returns null for an assistant error that is not a provider error', () => {
    const msg = createAssistantMessage({ content: { text: 'too long' }, apiError: 'max_output_tokens' })
    expect(currentProviderError(idle, [msg])).toBeNull()
  })

  it('returns null with no messages', () => {
    expect(currentProviderError(idle, undefined)).toBeNull()
    expect(currentProviderError(idle, [])).toBeNull()
  })
})

describe('ProviderErrorPlacement', () => {
  beforeEach(() => {
    Object.assign(mockStreamState, idle)
    mockMessages.length = 0
  })

  const composer = <div data-testid="composer">composer</div>
  const mount = (placement: 'composer' | 'inline' = 'composer') =>
    render(<ProviderErrorPlacement placement={placement} sessionId="s" agentSlug="a">{composer}</ProviderErrorPlacement>)

  it('renders its children untouched when there is no current error', () => {
    mount()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
    expect(screen.queryByTestId('provider-error-placement-composer')).not.toBeInTheDocument()
  })

  it('renders only children for an error whose placement is inline', () => {
    mockStreamState.error = 'API rate limit exceeded'
    mockStreamState.apiErrorCode = 'rate_limit'
    mockStreamState.errorPresentation = inlineError
    mount()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
    expect(screen.queryByTestId('provider-error-card')).not.toBeInTheDocument()
  })

  it('renders only children for an error with no presentation (placement defaults to inline)', () => {
    mockStreamState.error = 'API rate limit exceeded'
    mockStreamState.apiErrorCode = 'rate_limit'
    mount()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
    expect(screen.queryByTestId('provider-error-card')).not.toBeInTheDocument()
  })

  it('renders the component in place of children for a live error routed to composer', () => {
    mockStreamState.error = 'API Error: 402'
    mockStreamState.apiErrorCode = 'billing_error'
    mockStreamState.errorPresentation = composerError
    mount()
    expect(screen.getByTestId('provider-error-placement-composer')).toBeInTheDocument()
    expect(screen.getByTestId('provider-error-card')).toHaveTextContent('Routed: replaces the composer')
  })

  it('hands the displaced children to the component (the default card renders them back)', () => {
    mockStreamState.error = 'API Error: 402'
    mockStreamState.apiErrorCode = 'billing_error'
    mockStreamState.errorPresentation = composerError
    mount()
    const placement = screen.getByTestId('provider-error-placement-composer')
    expect(placement).toContainElement(screen.getByTestId('composer'))
  })

  it('renders a persisted error routed to composer once the session is idle', () => {
    mockMessages.push(createUserMessage(), errorMessage(composerError))
    mount()
    expect(screen.getByTestId('provider-error-card')).toHaveTextContent('Routed: replaces the composer')
  })

  it('renders an inline-routed error only in the inline placement', () => {
    mockMessages.push(errorMessage(inlineError))
    mount('inline')
    expect(screen.getByTestId('provider-error-placement-inline')).toBeInTheDocument()
  })
})
