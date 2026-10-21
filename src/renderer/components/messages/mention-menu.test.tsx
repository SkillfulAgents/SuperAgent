// @vitest-environment jsdom
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

if (typeof localStorage === 'undefined' || !localStorage) {
  const memory = new Map<string, string>()
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
    removeItem: (key: string) => { memory.delete(key) },
    clear: () => memory.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true })
}
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiAgent } from '@shared/lib/types/api'
import { formatChipMarker } from '@renderer/lib/chip-marker'

const state = vi.hoisted(() => ({
  isAuthMode: true,
  canAdmin: true,
  members: [] as Array<{ id: string; name: string; email: string; image: string | null; role: 'owner' | 'user' | 'viewer' }>,
  outsiders: [] as Array<{ id: string; name: string; email: string; image: string | null }>,
  agents: [] as Array<Pick<ApiAgent, 'slug' | 'displaySlug' | 'name' | 'avatar'>>,
  sessions: [] as Array<{ id: string; name: string; lastActivityAt: string }>,
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ user: { id: 'me' }, isAuthMode: state.isAuthMode, isAdmin: false, canAdminAgent: () => state.canAdmin }),
}))
vi.mock('@renderer/hooks/use-agent-members', () => ({
  useAgentMembers: () => ({ data: state.isAuthMode ? state.members : undefined }),
}))
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: (options?: { select?: (agents: unknown[]) => unknown }) => ({
    data: options?.select ? options.select(state.agents) : state.agents,
  }),
}))
vi.mock('@renderer/hooks/use-sessions', () => ({
  useSessions: () => ({ data: state.sessions }),
}))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(async () => new Response(JSON.stringify(state.outsiders))),
}))

import { MarkdownComposerEditor } from './markdown-composer-editor'
import { useMentionDirectory } from './mention-chip'
import { recordChatUse } from '@renderer/lib/chat-usage'

const me = { id: 'me', name: 'Dana Lee', email: 'dana@acme.com', image: null, role: 'owner' as const }
const mike = { id: 'mike-id', name: 'Mike Smith', email: 'mike@acme.com', image: null, role: 'user' as const }
const support = { slug: 'support01x', displaySlug: 'support-agent-support01x', name: 'Support Agent', avatar: null }
const minutes = { slug: 'minutes01x', displaySlug: 'minutes-bot-minutes01x', name: 'Minutes Bot', avatar: null }

function Editor({ pickers }: { pickers: boolean }) {
  const [value, setValue] = useState('')
  const directory = useMentionDirectory(support.slug)
  return (
    <>
      <MarkdownComposerEditor
        value={value}
        onChange={setValue}
        placeholder="Write a message"
        dataTestId="markdown-editor"
        chipContext={{ agentSlug: support.slug, sessionId: 'open-chat', ...directory }}
        pickers={pickers}
      />
      <output data-testid="markdown-value">{value}</output>
    </>
  )
}

function Composer({ pickers = true }: { pickers?: boolean }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Editor pickers={pickers} />
    </QueryClientProvider>
  )
}

const options = () => within(screen.getByTestId('mention-menu')).getAllByRole('option')
const listed = () => options().map((option) => option.dataset.testid)

describe('the @ menu', () => {
  beforeEach(() => {
    state.isAuthMode = true
    state.canAdmin = true
    state.members = [me, mike]
    state.outsiders = []
    state.agents = [support, minutes]
    state.sessions = []
    localStorage.clear()
  })

  it('lists teammates and agents together, never you or this agent', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    await user.type(screen.getByTestId('markdown-editor'), '@')

    expect(listed()).toEqual(['mention-option-user-mike-id', 'mention-option-agent-minutes01x'])
    expect(options()[0]).toHaveTextContent('mike@acme.com')
    expect(options()[1]).toHaveTextContent('Agent')
  })

  it('narrows to the names that match, and Enter picks the first as a chip', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByTestId('markdown-editor')
    await user.type(editor, 'ping @mi')
    expect(options()).toHaveLength(2)

    await user.keyboard('{Enter}')

    expect(screen.queryByTestId('mention-menu')).toBeNull()
    expect(screen.getByTestId('markdown-value').textContent).toBe(
      `ping ${formatChipMarker({ kind: 'user', referent: 'mike-id', label: 'Mike Smith' })} `,
    )
    const chip = within(editor).getByTestId('user-mention')
    expect(chip).toHaveTextContent('@Mike Smith')
    // The chip's avatar, drawn by React into the chip.
    expect(within(chip).getByRole('img', { name: 'Mike Smith' })).toBeInTheDocument()
  })

  it('moves with the arrow keys and picks with Tab', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    await user.type(screen.getByTestId('markdown-editor'), '@')
    await user.keyboard('{ArrowDown}{Tab}')

    expect(screen.getByTestId('markdown-value').textContent).toBe(
      `${formatChipMarker({ kind: 'agent', referent: 'minutes01x', label: 'Minutes Bot' })} `,
    )
  })

  it('stays closed after Escape until another @ is typed', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByTestId('markdown-editor')
    await user.type(editor, '@m')
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('mention-menu')).toBeNull()

    await user.type(editor, 'i')
    expect(screen.queryByTestId('mention-menu')).toBeNull()
    await user.type(editor, ' @')
    expect(screen.getByTestId('mention-menu')).toBeInTheDocument()
  })

  it('offers people the agent is not shared with to whoever can share it', async () => {
    state.outsiders = [{ id: 'sara-id', name: 'Sara Kim', email: 'sara@acme.com', image: null }]
    const user = userEvent.setup()
    render(<Composer />)
    await user.type(screen.getByTestId('markdown-editor'), '@sa')

    await waitFor(() => expect(listed()).toEqual(['mention-option-user-sara-id']))
    expect(options()[0]).toHaveTextContent('No access yet')
  })

  it("offers only the agent's people to anyone who cannot share it", async () => {
    state.canAdmin = false
    state.outsiders = [{ id: 'sara-id', name: 'Sara Kim', email: 'sara@acme.com', image: null }]
    const user = userEvent.setup()
    render(<Composer />)
    await user.type(screen.getByTestId('markdown-editor'), '@')

    expect(listed()).toEqual(['mention-option-user-mike-id', 'mention-option-agent-minutes01x'])
  })

  it('has only agents outside auth mode', async () => {
    state.isAuthMode = false
    const user = userEvent.setup()
    render(<Composer />)
    await user.type(screen.getByTestId('markdown-editor'), '@')

    expect(listed()).toEqual(['mention-option-agent-minutes01x'])
  })

  it('does not open in a composer with no room for it', async () => {
    const user = userEvent.setup()
    render(<Composer pickers={false} />)
    await user.type(screen.getByTestId('markdown-editor'), '@')

    expect(screen.queryByTestId('mention-menu')).toBeNull()
  })

  it('does not open inside code or mid-word', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByTestId('markdown-editor')
    await user.type(editor, 'mail dana@')
    expect(screen.queryByTestId('mention-menu')).toBeNull()

    await user.type(editor, ' `@')
    expect(screen.queryByTestId('mention-menu')).toBeNull()
  })

  describe('chats', () => {
    beforeEach(() => {
      state.sessions = [
        { id: 'q3-chat', name: 'Q3 revenue numbers', lastActivityAt: '2026-10-01T10:00:00Z' },
        { id: 'quarter-chat', name: 'Quarterly hiring plan', lastActivityAt: '2026-10-20T10:00:00Z' },
        { id: 'open-chat', name: 'Quick question', lastActivityAt: '2026-10-21T10:00:00Z' },
      ]
    })

    it('lists the most used chats first, below people and agents, never the open one', async () => {
      recordChatUse('q3-chat')
      recordChatUse('q3-chat')
      const user = userEvent.setup()
      render(<Composer />)
      await user.type(screen.getByTestId('markdown-editor'), '@')

      expect(listed()).toEqual([
        'mention-option-user-mike-id',
        'mention-option-agent-minutes01x',
        'mention-option-chat-q3-chat',
        'mention-option-chat-quarter-chat',
      ])
      expect(within(screen.getByTestId('mention-menu')).getByText('Chats')).toBeInTheDocument()
    })

    it('falls back to the latest chat when none was used here', async () => {
      const user = userEvent.setup()
      render(<Composer />)
      await user.type(screen.getByTestId('markdown-editor'), '@')

      expect(listed().slice(2)).toEqual(['mention-option-chat-quarter-chat', 'mention-option-chat-q3-chat'])
    })

    it('matches letters in order, and picks a chat as a chip', async () => {
      const user = userEvent.setup()
      render(<Composer />)
      await user.type(screen.getByTestId('markdown-editor'), 'use @q3rev')

      expect(listed()).toEqual(['mention-option-chat-q3-chat'])
      await user.keyboard('{Enter}')
      expect(screen.getByTestId('markdown-value').textContent).toBe(
        `use ${formatChipMarker({ kind: 'chat', referent: 'q3-chat', label: 'Q3 revenue numbers' })} `,
      )
      expect(within(screen.getByTestId('markdown-editor')).getByTestId('chat-mention')).toHaveTextContent('@Q3 revenue numbers')
    })
  })
})
