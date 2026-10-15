// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeChatIntegration } from './test-factories'

const state = vi.hoisted(() => ({ connected: true, transport: 'direct' as 'direct' | 'relay' | null, relayAvailable: false }))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async (url: string) => Response.json(url === '/api/webhook-relay'
    ? { available: state.relayAvailable }
    : { status: 'active', connected: state.connected, transport: state.transport, provider: 'imessage' }),
}))
import { IMessageDeliveryCard } from './imessage-delivery-card'

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const integration = makeChatIntegration({ provider: 'imessage' })

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  Object.assign(state, { connected: true, transport: 'direct', relayAvailable: false })
})

describe('IMessageDeliveryCard', () => {
  it('shows delivery through webhooks', async () => {
    Object.assign(state, { transport: 'relay', relayAvailable: true })
    render(<IMessageDeliveryCard integration={integration} />, { wrapper })

    await waitFor(() => expect(screen.getByTestId('delivery-path')).toHaveTextContent('Through webhooks'))
    expect(screen.queryByTestId('delivery-next')).toBeNull()
  })

  it('shows the live connection, with the gateway holding offline messages', async () => {
    render(<IMessageDeliveryCard integration={integration} />, { wrapper })

    await waitFor(() => expect(screen.getByTestId('delivery-path')).toHaveTextContent('live connection to the iMessage gateway'))
    expect(screen.getByTestId('delivery-path')).toHaveTextContent('up to 24 hours')
    expect(screen.queryByTestId('delivery-next')).toBeNull()
  })

  it('says webhooks start on the next connect when a relay appeared after this one', async () => {
    state.relayAvailable = true
    render(<IMessageDeliveryCard integration={integration} />, { wrapper })

    await waitFor(() => expect(screen.getByTestId('delivery-next')).toHaveTextContent('next time it connects'))
  })

  it('says when it is not connected', async () => {
    Object.assign(state, { connected: false, transport: null, relayAvailable: true })
    render(<IMessageDeliveryCard integration={integration} />, { wrapper })

    await waitFor(() => expect(screen.getByTestId('delivery-path')).toHaveTextContent('Not connected'))
    expect(screen.queryByTestId('delivery-next')).toBeNull()
  })
})
