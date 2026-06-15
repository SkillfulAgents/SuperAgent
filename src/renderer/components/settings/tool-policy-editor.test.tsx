// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolPolicyEditor } from './tool-policy-editor'
import { renderWithProviders, screen, waitFor, within } from '@renderer/test/test-utils'

// Route apiFetch: GET returns the configured policies fixture; PUT captures its body.
let policiesFixture: Array<{ toolName: string; decision: string }> = []
let lastPutBody: { policies: Array<{ toolName: string; decision: string }> } | null = null

const mockApiFetch = vi.fn((url: string, opts?: { method?: string; body?: string }) => {
  if (opts?.method === 'PUT') {
    lastPutBody = JSON.parse(opts.body as string)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ policies: policiesFixture }) })
})
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...(args as [string, never])),
}))

const TOOLS = [
  { name: 'search', description: 'Search the index' },
  { name: 'send', description: 'Send a message' },
]

const toolToggle = (tool: string, decision: 'allow' | 'review' | 'block') =>
  within(screen.getByTestId(`tool-row-${tool}`)).getByTestId(`policy-toggle-${decision}`)

const renderEditor = (mcpId: string) =>
  renderWithProviders(
    <ToolPolicyEditor mcpId={mcpId} mcpName="Test MCP" tools={TOOLS} open onOpenChange={() => {}} />,
  )

describe('ToolPolicyEditor — Save enable/disable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    policiesFixture = []
    lastPutBody = null
  })

  it('disables Save for a configured MCP until a change is made', async () => {
    // Already configured → the form matches what's persisted, so nothing to save.
    policiesFixture = [{ toolName: 'send', decision: 'block' }]
    renderEditor('mcp-1')
    await waitFor(() => expect(screen.getByTestId('tool-row-send')).toBeInTheDocument())

    expect(screen.getByTestId('tool-policy-save')).toBeDisabled()

    // Flip a per-tool policy — now the editor differs from what's persisted.
    toolToggle('search', 'allow').click()
    await waitFor(() => expect(screen.getByTestId('tool-policy-save')).toBeEnabled())
  })

  it('disables Save on load for a fresh MCP (no baseline, nothing to save)', async () => {
    // Unlike the scope editor, the tool editor pre-fills nothing, so a brand-new
    // MCP starts all-default → there is genuinely nothing to save yet.
    policiesFixture = []
    renderEditor('mcp-2')
    await waitFor(() => expect(screen.getByTestId('tool-row-send')).toBeInTheDocument())

    expect(screen.getByTestId('tool-policy-save')).toBeDisabled()

    toolToggle('send', 'block').click()
    await waitFor(() => expect(screen.getByTestId('tool-policy-save')).toBeEnabled())
  })

  it('re-disables Save after a successful save', async () => {
    policiesFixture = [{ toolName: 'send', decision: 'block' }]
    renderEditor('mcp-3')
    await waitFor(() => expect(screen.getByTestId('tool-row-send')).toBeInTheDocument())

    toolToggle('search', 'allow').click()
    await waitFor(() => expect(screen.getByTestId('tool-policy-save')).toBeEnabled())

    screen.getByTestId('tool-policy-save').click()
    await waitFor(() => expect(lastPutBody).not.toBeNull())
    // The just-saved state is now the persisted baseline → nothing left to save.
    await waitFor(() => expect(screen.getByTestId('tool-policy-save')).toBeDisabled())
  })

  it('disables Save again when a change is reverted by hand', async () => {
    policiesFixture = []
    renderEditor('mcp-4')
    await waitFor(() => expect(screen.getByTestId('tool-row-send')).toBeInTheDocument())

    // Set then unset the same toggle → back to the persisted (empty) state.
    toolToggle('search', 'allow').click()
    await waitFor(() => expect(screen.getByTestId('tool-policy-save')).toBeEnabled())
    toolToggle('search', 'allow').click() // clicking the active option resets to default
    await waitFor(() => expect(screen.getByTestId('tool-policy-save')).toBeDisabled())
  })
})
