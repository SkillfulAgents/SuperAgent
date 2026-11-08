// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { OllamaStatus } from '@shared/lib/llm-provider/ollama-schema'

const state = vi.hoisted(() => ({
  os: 'darwin' as string | undefined,
  remote: false,
  status: null as unknown,
  bodies: [] as unknown[],
}))
vi.mock('@renderer/lib/facts', () => ({ serverFacts: () => (state.os ? { os: state.os } : null) }))
vi.mock('@renderer/lib/capabilities', () => ({ canUseHostFeatures: () => !state.remote }))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async (_url: string, init?: RequestInit) => {
    if (init?.body) state.bodies.push(JSON.parse(init.body as string))
    return new Response(JSON.stringify(state.status))
  },
}))

import { installOptionFor, OllamaSetupPanel } from './ollama-setup-panel'

const BASE = 'http://localhost:11434'
const down = (kind: 'stopped' | 'not-found' | 'unreachable'): OllamaStatus => ({ state: kind, baseUrl: BASE, error: `Could not connect to ${BASE}` })
const running = (extra: Partial<Extract<OllamaStatus, { state: 'running' }>> = {}): OllamaStatus => ({
  state: 'running',
  baseUrl: BASE,
  version: '0.40.15',
  upgradeRequired: false,
  models: [{ id: 'qwen3.8:latest', label: 'qwen3.8', supportsThinking: true, supportsImageInput: false }],
  ...extra,
})

function renderPanel(status: OllamaStatus, props: Partial<Parameters<typeof OllamaSetupPanel>[0]> = {}) {
  state.status = status
  const onBaseUrlChange = vi.fn()
  const onManageModels = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <OllamaSetupPanel baseUrl={BASE} onBaseUrlChange={onBaseUrlChange} onManageModels={onManageModels} canDownload {...props} />
    </QueryClientProvider>,
  )
  return { onBaseUrlChange, onManageModels }
}

beforeEach(() => {
  state.os = 'darwin'
  state.remote = false
  state.bodies = []
})

describe('installOptionFor', () => {
  it('gives each platform its own way in', () => {
    expect(installOptionFor('darwin').link.href).toBe('https://ollama.com/download/mac')
    expect(installOptionFor('win32').command?.value).toContain('install.ps1')
    expect(installOptionFor('linux').command?.value).toContain('install.sh')
    expect(installOptionFor(undefined).link.href).toBe('https://ollama.com/download')
  })
})

describe('OllamaSetupPanel', () => {
  it('shows install instructions when Ollama is not found', async () => {
    renderPanel(down('not-found'))
    expect(await screen.findByText(/wasn't found on this computer/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Download Ollama for Mac/ }).getAttribute('href')).toBe('https://ollama.com/download/mac')
  })

  it('shows the Linux command when the server runs Linux', async () => {
    state.os = 'linux'
    renderPanel(down('not-found'))
    expect(await screen.findByText('curl -fsSL https://ollama.com/install.sh | sh')).toBeTruthy()
  })

  it('names the server\'s machine outside the desktop app, as in a browser or on a cloud workspace', async () => {
    state.remote = true
    renderPanel(down('not-found'))
    expect(await screen.findByText(/on the machine running this workspace/)).toBeTruthy()
  })

  it('says how to start it, not install it, when it is installed but stopped', async () => {
    renderPanel(down('stopped'))
    expect(await screen.findByText(/installed but not running/)).toBeTruthy()
    expect(screen.getByText('ollama serve')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull()
  })

  it('opens the address field by itself when another machine does not answer', async () => {
    renderPanel(down('unreachable'))
    expect(await screen.findByText(/Can't reach Ollama/)).toBeTruthy()
    expect(screen.getByLabelText('Ollama address')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull()
  })

  it('shows status and model count when running', async () => {
    const { onManageModels } = renderPanel(running())
    expect(await screen.findByText(/Ollama is running · v0.40.15/)).toBeTruthy()
    expect(screen.getByText(/1 model ready for agents/)).toBeTruthy()
    await userEvent.click(screen.getByTestId('ollama-manage-models'))
    expect(onManageModels).toHaveBeenCalled()
  })

  it('does not count a model agents cannot run', async () => {
    renderPanel(running({ models: [{ id: 'e:latest', label: 'e', supportsThinking: false, supportsImageInput: false, unusableReason: 'embedding-only' }] }))
    expect(await screen.findByText(/No models yet/)).toBeTruthy()
  })

  it('offers viewing rather than downloading to someone who may not pull', async () => {
    renderPanel(running(), { canDownload: false })
    expect(await screen.findByRole('button', { name: 'View models' })).toBeTruthy()
  })

  it('warns about a version too old, and a context too small', async () => {
    renderPanel(running({ upgradeRequired: true, smallContext: { model: 'm:latest', tokens: 4096 } }))
    expect(await screen.findByText(/too old to run agents/)).toBeTruthy()
    expect(screen.getByText(/OLLAMA_CONTEXT_LENGTH/)).toBeTruthy()
  })

  it('only mentions the bridge bind on Linux, for a server on this machine', async () => {
    state.os = 'linux'
    renderPanel(running())
    expect(await screen.findByText(/OLLAMA_HOST=0.0.0.0/)).toBeTruthy()
  })

  it('tests a custom address, normalized, without submitting the form around it', async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    state.status = down('not-found')
    const onBaseUrlChange = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <form onSubmit={onSubmit}>
          <OllamaSetupPanel baseUrl={BASE} onBaseUrlChange={onBaseUrlChange} onManageModels={() => {}} canDownload />
        </form>
      </QueryClientProvider>,
    )
    await userEvent.click(await screen.findByTestId('ollama-connection-settings-trigger'))
    const input = screen.getByLabelText('Ollama address')
    await userEvent.clear(input)
    await userEvent.type(input, '10.0.0.5:9000{Enter}')
    expect(onBaseUrlChange).toHaveBeenCalledWith('http://10.0.0.5:9000')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('explains an address it cannot use, and keeps the last good one', async () => {
    const { onBaseUrlChange } = renderPanel(down('not-found'))
    await userEvent.click(await screen.findByTestId('ollama-connection-settings-trigger'))
    const input = screen.getByLabelText('Ollama address')
    await userEvent.clear(input)
    await userEvent.type(input, 'http://my-mac:11434')
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('my-mac'))
    expect(onBaseUrlChange).not.toHaveBeenCalled()
  })
})
