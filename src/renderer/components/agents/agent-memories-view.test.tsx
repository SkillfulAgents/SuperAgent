// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AgentMemoriesView } from './agent-memories-view'

const { navigate, apiFetch, user } = vi.hoisted(() => ({
  navigate: vi.fn(), apiFetch: vi.fn(),
  user: { isAuthMode: false, rolesReady: true, canAdminAgent: () => false },
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate, useBlocker: () => ({ status: 'idle' }) }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => user }))
vi.mock('@renderer/lib/api', () => ({ apiFetch }))
vi.mock('@renderer/components/layout/settings-page', () => ({
  SettingsPageContainer: ({ children }: any) => <div>{children}</div>,
  PageTitle: ({ title, back, actions }: any) => <div><h2>{title}</h2><button onClick={back.onClick}>{back.label}</button>{actions}</div>,
}))

const initial = {
  path: 'style.md', title: 'Writing style', description: 'How to write', type: 'feedback', isIndex: false,
  content: '---\nname: Writing style\ndescription: How to write\nmetadata:\n  type: feedback\n---\nBe concise.', body: 'Be concise.', revision: 'a'.repeat(64),
}
let doc = { ...initial }
let conflict = false
let validationError = false
let client: QueryClient

beforeEach(() => {
  doc = { ...initial }
  conflict = false
  validationError = false
  user.isAuthMode = false
  apiFetch.mockReset()
  apiFetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'PUT') {
      if (validationError) return Response.json({ error: 'Frontmatter "name" must be non-empty text.' }, { status: 422 })
      if (conflict) return Response.json({ error: 'This memory changed since you opened it. Your draft has been kept.' }, { status: 409 })
      const data = JSON.parse(options.body as string)
      doc = { ...doc, content: data.content, body: data.content, revision: 'b'.repeat(64) }
      return Response.json(doc)
    }
    if (url.includes('/content?')) return Response.json(doc)
    return Response.json({ memories: [doc] })
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
})
afterEach(() => { cleanup(); client.clear() })

function setup() {
  const events = userEvent.setup()
  render(<QueryClientProvider client={client}><AgentMemoriesView agentSlug="agent" /></QueryClientProvider>)
  return events
}

async function openEditor(events: ReturnType<typeof userEvent.setup>) {
  await events.click(await screen.findByRole('button', { name: /Writing style/ }))
  await events.click(await screen.findByRole('button', { name: 'Edit' }))
  return screen.getByLabelText('Memory contents')
}

describe('Memories page', () => {
  it('opens and saves full Markdown, then shows the saved preview', async () => {
    const events = setup()
    const editor = await openEditor(events)
    expect(editor).toHaveValue(initial.content)
    await events.clear(editor)
    const updated = initial.content + '\n\n# Updated memory'
    await events.type(editor, updated)
    await events.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('heading', { name: 'Updated memory' })).toBeVisible()
    expect(doc.content).toBe(updated)
    const write = apiFetch.mock.calls.find(([, options]) => options?.method === 'PUT')!
    expect(JSON.parse(write[1].body)).toMatchObject({ path: 'style.md', revision: initial.revision })
  })

  it('keeps the draft and original revision through refetch and a conflicting save', async () => {
    const events = setup()
    const editor = await openEditor(events)
    await events.clear(editor)
    await events.type(editor, 'My draft')
    client.setQueryData(['agent-memory', 'agent', 'style.md'], { ...doc, content: 'Agent edit', revision: 'c'.repeat(64) })
    expect(editor).toHaveValue('My draft')
    conflict = true
    await events.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('changed since you opened')
    expect(editor).toHaveValue('My draft')
    const write = apiFetch.mock.calls.find(([, options]) => options?.method === 'PUT')!
    expect(JSON.parse(write[1].body).revision).toBe(initial.revision)
  })

  it('asks before discarding a draft when going back', async () => {
    const events = setup()
    const editor = await openEditor(events)
    await events.type(editor, 'More')
    await events.click(screen.getByRole('button', { name: 'All memories' }))
    expect(await screen.findByRole('alertdialog')).toBeVisible()
    await events.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(editor).toHaveValue(initial.content + 'More')
    await events.click(screen.getByRole('button', { name: 'All memories' }))
    await events.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(await screen.findByRole('heading', { name: 'Memories' })).toBeVisible()
    expect(apiFetch.mock.calls.every(([, options]) => options?.method !== 'PUT')).toBe(true)
  })

  it('shows the empty state and searches by description', async () => {
    const events = setup()
    await screen.findByRole('button', { name: /Writing style/ })
    await events.type(screen.getByLabelText('Search memories'), 'unknown')
    expect(screen.getByText('No memories match your search.')).toBeVisible()
    apiFetch.mockResolvedValue(Response.json({ memories: [] }))
    await events.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('No memories yet')).toBeVisible()
  })

  it('does not request memories for a non-admin', async () => {
    user.isAuthMode = true
    setup()
    expect(screen.getByText('Only agent admins can view and edit memories.')).toBeVisible()
    await waitFor(() => expect(apiFetch).not.toHaveBeenCalled())
  })
  it('keeps an invalid draft editable and lets the user fix and save it', async () => {
    const events = setup()
    const editor = await openEditor(events)
    await events.clear(editor)
    await events.type(editor, '# Invalid draft')
    validationError = true
    await events.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Frontmatter "name" must be non-empty text.')
    expect(editor).toHaveValue('# Invalid draft')
    expect(editor).toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByRole('button', { name: 'Reload latest version' })).not.toBeInTheDocument()
    expect(doc.content).toBe(initial.content)
    validationError = false
    await events.clear(editor)
    await events.type(editor, initial.content + '\nRepaired')
    await events.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Memory saved.')).toBeVisible()
  })

})
