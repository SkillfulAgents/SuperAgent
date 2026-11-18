// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeChatIntegration } from './test-factories'

const state = vi.hoisted(() => ({ connected: true, transport: 'direct' as 'direct' | 'relay' | null, relayAvailable: false }))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async (url: string) => Response.json(url === '/api/webhook-relay'
    ? { available: state.relayAvailable }
    : { status: 'active', connected: state.connected, transport: state.transport, provider: 'platform-email' }),
}))
import { EmailDeliveryCard } from './email-delivery-card'

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const integration = makeChatIntegration({ id: 'email-1' })

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  Object.assign(state, { connected: true, transport: 'direct', relayAvailable: false })
})

describe('EmailDeliveryCard', () => {
  it('shows mail arriving through webhooks', async () => {
    Object.assign(state, { transport: 'relay', relayAvailable: true })
    render(<EmailDeliveryCard integration={integration} />, { wrapper })

    await waitFor(() => expect(screen.getByTestId('delivery-path')).toHaveTextContent('Through webhooks'))
    expect(screen.queryByTestId('delivery-next')).toBeNull()
  })

  it('shows the live connection to the email gateway, and that webhooks start on the next connect', async () => {
    state.relayAvailable = true
    render(<EmailDeliveryCard integration={integration} />, { wrapper })

    await waitFor(() => expect(screen.getByTestId('delivery-path')).toHaveTextContent('live connection to the email gateway'))
    expect(screen.getByTestId('delivery-next')).toHaveTextContent('next time it connects')
  })
})
