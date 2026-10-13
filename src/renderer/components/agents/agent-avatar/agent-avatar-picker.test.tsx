// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { ApiAgent } from '@shared/lib/types/api'
import { agentAvatarSchema } from '@shared/lib/types/agent-avatar'
import { apiFetch } from '@renderer/lib/api'
import { AgentAvatar } from './agent-avatar'
import { AgentAvatarPicker } from './agent-avatar-picker'
import { OFFERED_ORBS } from './avatar-orbs'
import { ORB_SHAPES } from './orb-shapes'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))

const first: ApiAgent = {
  slug: 'first', displaySlug: 'first', name: 'First', createdAt: new Date(),
  status: 'stopped', containerPort: null, avatar: { color: 'tonal-blue', shape: 'circle' },
}
const initialSecond: ApiAgent = {
  ...first, slug: 'second', displaySlug: 'second', name: 'Second',
  avatar: { color: 'tonal-green', shape: 'triangle' },
}
let second: ApiAgent
const clients: QueryClient[] = []
const orbOf = (id: string) => screen.getByTestId(id).querySelector('[data-avatar-orb]')?.getAttribute('data-avatar-orb')
const shapeOf = (id: string) => screen.getByTestId(id).querySelector('[data-avatar-shape]')?.getAttribute('data-avatar-shape')

function Harness() {
  const { data = [] } = useQuery({ queryKey: ['agents'], queryFn: async () => [first, second] })
  const edited = data.find(agent => agent.slug === 'second')!
  return <>
    <AgentAvatarPicker agent={edited} />
    {data.map(agent => <span key={agent.slug} data-testid={agent.slug}><AgentAvatar agent={agent} /></span>)}
  </>
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  client.setQueryData(['agents'], [first, second])
  return render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
}

beforeEach(() => {
  second = initialSecond
  vi.mocked(apiFetch).mockReset().mockImplementation(async (_url, init) => {
    const avatar = agentAvatarSchema.parse(JSON.parse(String(init?.body)))
    second = { ...second, avatar }
    return Response.json(avatar)
  })
})
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
})

it('shows the persisted pair and opens with that color and shape selected', async () => {
  mount()
  expect(orbOf('first')).toBe('tonal-blue')
  expect(orbOf('second')).toBe('tonal-green')
  expect(shapeOf('second')).toBe('triangle')
  await userEvent.click(screen.getByRole('button', { name: "Change Second's avatar" }))
  expect(screen.getByRole('button', { name: 'Green' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 'Triangle' })).toHaveAttribute('aria-pressed', 'true')
})

it('previews locally, saves both fields once on close, and reads the saved pair in a new client', async () => {
  const user = userEvent.setup()
  const view = mount()
  await user.click(screen.getByRole('button', { name: "Change Second's avatar" }))
  for (const orb of OFFERED_ORBS) expect(screen.getByRole('button', { name: orb.label })).toBeInTheDocument()
  for (const shape of ORB_SHAPES) expect(screen.getByRole('button', { name: shape.label })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Bloom' }))
  await user.click(screen.getByRole('button', { name: 'Red / Amber' }))
  expect(shapeOf('agent-avatar-picker')).toBe('bloom')
  expect(orbOf('agent-avatar-picker')).toBe('duo-red-amber')
  expect(shapeOf('second')).toBe('triangle')
  expect(apiFetch).not.toHaveBeenCalled()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(shapeOf('second')).toBe('bloom'))
  expect(apiFetch).toHaveBeenCalledExactlyOnceWith('/api/agents/second/avatar', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ color: 'duo-red-amber', shape: 'bloom' }),
  })
  expect(orbOf('first')).toBe('tonal-blue')
  view.unmount()
  mount()
  expect(orbOf('second')).toBe('duo-red-amber')
  expect(shapeOf('second')).toBe('bloom')
})

it('saves when dismissed by clicking outside, but skips unchanged choices', async () => {
  const user = userEvent.setup()
  mount()
  await user.click(screen.getByRole('button', { name: "Change Second's avatar" }))
  await user.keyboard('{Escape}')
  expect(apiFetch).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: "Change Second's avatar" }))
  await user.click(screen.getByRole('button', { name: 'Pill' }))
  await user.click(document.body)
  await waitFor(() => expect(shapeOf('second')).toBe('pill'))
})

it('does not overwrite a remote change when an untouched picker closes', async () => {
  const user = userEvent.setup()
  mount()
  await user.click(screen.getByRole('button', { name: "Change Second's avatar" }))
  await act(async () => {
    second = { ...second, avatar: { color: 'tonal-red', shape: 'bloom' } }
    clients.at(-1)!.setQueryData(['agents'], [first, second])
  })
  await waitFor(() => expect(shapeOf('second')).toBe('bloom'))
  await user.keyboard('{Escape}')
  expect(apiFetch).not.toHaveBeenCalled()
  expect(shapeOf('agent-avatar-picker')).toBe('bloom')
  expect(orbOf('agent-avatar-picker')).toBe('tonal-red')
})

it('keeps the last persisted avatar when the server rejects a save', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response('Save failed', { status: 500 }))
  const user = userEvent.setup()
  mount()
  await user.click(screen.getByRole('button', { name: "Change Second's avatar" }))
  await user.click(screen.getByRole('button', { name: 'Bloom' }))
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.getByTestId('agent-avatar-picker')).not.toBeDisabled())
  expect(shapeOf('agent-avatar-picker')).toBe('triangle')
  expect(shapeOf('second')).toBe('triangle')
})
