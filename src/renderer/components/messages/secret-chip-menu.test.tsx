// @vitest-environment jsdom
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiFetch } from '@renderer/lib/api'
import { MarkdownComposerEditor } from './markdown-composer-editor'
import type { ChipContext } from './composer-chips'
import { secretMarker } from './secret-chip'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: vi.fn() }),
}))

const marker = secretMarker({ envVar: 'API_KEY', key: 'My Key' })

function ControlledEditor({ initialValue, chipContext }: { initialValue: string; chipContext: ChipContext }) {
  const [value, setValue] = useState(initialValue)
  return (
    <>
      <MarkdownComposerEditor
        value={value}
        onChange={setValue}
        placeholder="Write a message"
        dataTestId="markdown-editor"
        chipContext={chipContext}
      />
      <output data-testid="markdown-value">{value}</output>
    </>
  )
}

function renderEditor(chipContext: ChipContext, initialValue = `Use ${marker}`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ControlledEditor initialValue={initialValue} chipContext={chipContext} />
    </QueryClientProvider>
  )
}

async function openEditDialog() {
  fireEvent.contextMenu(screen.getByTestId('secured-secret'), { clientX: 20, clientY: 20 })
  await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'Edit key' }))
  return screen.findByRole('dialog', { name: 'Edit key' })
}

describe('secret chip menu', () => {
  afterEach(() => {
    cleanup()
    vi.mocked(apiFetch).mockReset()
  })

  it('renames a saved key and points the pill at its new env var', async () => {
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ id: 'PROD_KEY', key: 'Prod Key', envVar: 'PROD_KEY', hasValue: true }))
    renderEditor({ agentSlug: 'agent', secretEnvVars: new Set(['API_KEY']) })
    const user = userEvent.setup()

    const dialog = await openEditDialog()
    const name = screen.getByLabelText('Key name')
    expect(name).toHaveValue('My Key')
    expect(screen.getByLabelText('Secret value')).toHaveValue('')
    await user.clear(name)
    await user.type(name, 'Prod Key')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(apiFetch).toHaveBeenCalledWith('/api/agents/agent/secrets/API_KEY', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ key: 'Prod Key' }),
    }))
    expect(screen.getByTestId('markdown-value').textContent).toBe(`Use ${secretMarker({ envVar: 'PROD_KEY', key: 'Prod Key' })}`)
    expect(screen.getByTestId('secured-secret')).toHaveTextContent('[Prod Key | *********]')
  })

  it('saves a value for a key the agent lacks', async () => {
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ id: 'API_KEY', key: 'My Key', envVar: 'API_KEY', hasValue: true }))
    renderEditor({ agentSlug: 'agent', secretEnvVars: new Set() })
    const user = userEvent.setup()

    await openEditDialog()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    await user.type(screen.getByLabelText('Secret value'), 'synthetic-value')
    await user.click(save)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apiFetch).toHaveBeenCalledWith('/api/agents/agent/secrets', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ key: 'My Key', value: 'synthetic-value' }),
    }))
    expect(screen.getByTestId('markdown-value').textContent).toBe(`Use ${marker}`)
  })

  it('shows a failed save in the dialog and leaves the pill alone', async () => {
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ error: 'A secret with env var "TAKEN" already exists' }, { status: 409 }))
    renderEditor({ agentSlug: 'agent', secretEnvVars: new Set(['API_KEY']) })
    const user = userEvent.setup()

    await openEditDialog()
    await user.clear(screen.getByLabelText('Key name'))
    await user.type(screen.getByLabelText('Key name'), 'Taken')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('A secret with env var "TAKEN" already exists')
    expect(screen.getByTestId('markdown-value').textContent).toBe(`Use ${marker}`)
  })

  it('leaves the browser menu on text and closes its own on Escape', async () => {
    renderEditor({ agentSlug: 'agent', secretEnvVars: new Set(['API_KEY']) })
    const editor = screen.getByTestId('markdown-editor')

    expect(fireEvent.contextMenu(editor.querySelector('p')!)).toBe(true)
    expect(screen.queryByTestId('chip-menu')).not.toBeInTheDocument()

    expect(fireEvent.contextMenu(screen.getByTestId('secured-secret'))).toBe(false)
    expect(await screen.findByTestId('chip-menu')).toBeInTheDocument()
    await userEvent.setup().keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('chip-menu')).not.toBeInTheDocument())
    await waitFor(() => expect(editor).toHaveFocus())
  })
})
