// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeChatIntegration } from './test-factories'

const state = vi.hoisted(() => ({ connected: true, transport: 'direct' as 'direct' | 'relay' | null, relayAvailable: false }))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async (url: string) => Response.json(url === '/api/webhook-relay'
    ? { available: state.relayAvailable }
    : { status: 'active', connected: state.connected, transport: state.transport, provider: 'telegram' }),
}))
import { TelegramDeliveryCard } from './telegram-delivery-card'

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const integration = makeChatIntegration({ provider: 'telegram' })

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  Object.assign(state, { connected: true, transport: 'direct', relayAvailable: false })
})

describe('TelegramDeliveryCard', () => {
  it('shows delivery through the webhook', async () => {
    Object.assign(state, { transport: 'relay', relayAvailable: true })
    render(<TelegramDeliveryCard integration={integration} />, { wrapper })

    await waitFor(() => expect(screen.getByTestId('delivery-path')).toHaveTextContent('Through webhooks'))
    expect(screen.queryByTestId('delivery-next')).toBeNull()
  })

  it('shows long polling, with Telegram holding offline messages', async () => {
    render(<TelegramDeliveryCard integration={integration} />, { wrapper })

    await waitFor(() => expect(screen.getByTestId('delivery-path')).toHaveTextContent('By polling Telegram'))
    expect(screen.getByTestId('delivery-path')).toHaveTextContent('up to 24 hours')
    expect(screen.queryByTestId('delivery-next')).toBeNull()
  })

  it('says the webhook starts on the next connect when a relay appeared after this one', async () => {
    state.relayAvailable = true
    render(<TelegramDeliveryCard integration={integration} />, { wrapper })

    await waitFor(() => expect(screen.getByTestId('delivery-next')).toHaveTextContent('next time it connects'))
  })
})
