// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { WorkflowRunLive } from '@renderer/hooks/use-message-stream'
import type { WorkflowTree } from '@shared/lib/workflows/workflow-schemas'
import { WorkflowTrayContent } from './workflow-tray-content'

const apiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))
vi.mock('@renderer/lib/upload', () => ({ uploadFileChunked: vi.fn() }))
vi.mock('@renderer/lib/error-reporting', () => ({ captureRendererException: vi.fn() }))
vi.mock('@renderer/components/messages/tool-call-item', () => ({
  StatusIndicator: ({ status }: { status: string }) => <span>{status}</span>,
}))
vi.mock('./workflow-agent-transcript', () => ({ WorkflowAgentTranscript: () => null }))
vi.mock('@renderer/context/workflow-context', () => ({
  useWorkflow: () => ({
    openWorkflows: [{ runId: 'wf_test', name: 'deep-research' }],
    selectedRunId: 'wf_test',
    expandedAgentId: null,
    selectWorkflow: vi.fn(),
    setExpandedAgent: vi.fn(),
  }),
}))
let liveRun: WorkflowRunLive
vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ workflows: [liveRun] }),
}))

const emptyTree: WorkflowTree = {
  runId: 'wf_test', name: 'deep-research', description: null, phases: [], agents: [],
  expectedAgents: 0, totals: { toolCount: 0, tokens: 0, durationMs: null },
}
let queryClient: QueryClient
let requests: Array<{ resolve: (tree: WorkflowTree) => void; fail: () => void }>

beforeEach(() => {
  vi.useFakeTimers()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  requests = []
  apiFetch.mockReset().mockImplementation((_url: string, init?: RequestInit) => new Promise((resolve, reject) => {
    requests.push({
      resolve: (tree) => resolve({ ok: true, json: async () => tree }),
      fail: () => resolve({ ok: false, status: 500 }),
    })
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  }))
  liveRun = {
    toolUseId: 'tool-1', runId: 'wf_test', name: 'deep-research', startedAt: Date.now(),
    agents: {}, usage: { totalTokens: 320_700, toolUses: 150, durationMs: 467_000 },
  }
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.useRealTimers()
})

function tray() {
  return (
    <QueryClientProvider client={queryClient}>
      <WorkflowTrayContent agentSlug="researcher" sessionId="s1" onClose={() => {}} />
    </QueryClientProvider>
  )
}

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
}

function startAgent() {
  liveRun = {
    ...liveRun,
    agents: {
      ...liveRun.agents,
      a1: { status: 'running', result: null, label: 'search:reddit', phase: 'Research', lastTool: 'WebSearch' },
    },
  }
}

describe('workflow preview with slow or unavailable disk reconstruction', () => {
  it('keeps Scope and all five Search agents under the runtime phases when disk assignments disagree', async () => {
    const liveAgents: WorkflowRunLive['agents'] = {
      scope: { status: 'done', result: 'Five angles', label: 'scope', phase: 'Scope' },
    }
    for (let i = 0; i < 5; i++) {
      liveAgents[`search${i}`] = { status: 'running', result: null, label: `search:angle ${i}`, phase: 'Search' }
    }
    liveRun = { ...liveRun, agents: liveAgents }
    render(tray())
    requests[0].resolve({
      ...emptyTree,
      phases: ['Scope', 'Search', 'Fetch', 'Verify', 'Synthesize'].map(title => ({ title })),
      agents: Object.entries(liveAgents).map(([agentId, agent], index) => ({
        agentId, label: agent.label!, phase: ['Search', 'Fetch', 'Verify', 'Search', 'Search', 'Search'][index],
        status: agent.status, result: agent.result, resolved: 'ordinal-fallback',
        prompt: '', toolCount: 0, tokens: 0, durationMs: null, model: null,
      })),
    })
    await flush()
    const groups = screen.getAllByTestId('workflow-phase-group')
    const group = (phase: string) => within(groups.find(el => el.dataset.phase === phase)!)
    expect(group('Scope').getAllByTestId('workflow-agent-row')).toHaveLength(1)
    expect(group('Scope').getByText('scope')).toBeInTheDocument()
    expect(group('Search').getAllByTestId('workflow-agent-row')).toHaveLength(5)
    expect(group('Fetch').queryAllByTestId('workflow-agent-row')).toHaveLength(0)
    expect(group('Verify').queryAllByTestId('workflow-agent-row')).toHaveLength(0)
  })

  it('shows live agents while the first tree request is still pending, then survives its failure', async () => {
    const view = render(tray())
    expect(requests).toHaveLength(1)
    expect(screen.getByText('Loading workflow…')).toBeInTheDocument()

    startAgent()
    view.rerender(tray())
    expect(screen.getByText('search:reddit')).toBeInTheDocument()
    expect(screen.getByText('Research')).toBeInTheDocument()
    expect(screen.getByText('WebSearch')).toBeInTheDocument()
    expect(screen.getByText('0/1 agents done')).toBeInTheDocument()
    expect(screen.queryByText('Loading workflow…')).not.toBeInTheDocument()
    expect(requests).toHaveLength(1)

    requests[0].fail()
    await flush()
    expect(screen.getByText('search:reddit')).toBeInTheDocument()
    expect(screen.getByText('Some workflow details are unavailable. Retrying…')).toBeInTheDocument()
    expect(screen.queryByText('Starting workflow…')).not.toBeInTheDocument()
  })

  it('does not call a failed seven-minute workflow preview "starting" even without agent events', async () => {
    render(tray())
    requests[0].fail()
    await flush()
    expect(screen.getByText('Workflow is running. Retrying details…')).toBeInTheDocument()
    expect(screen.getByText(/150 tools/)).toBeInTheDocument()
  })

  it('reconciles live agents every 30 seconds instead of on each poll or status transition', async () => {
    startAgent()
    const view = render(tray())
    requests[0].resolve(emptyTree)
    await flush()

    liveRun = { ...liveRun, agents: { ...liveRun.agents, a1: { ...liveRun.agents.a1, status: 'done', result: 'Found evidence' } } }
    view.rerender(tray())
    expect(screen.getByText('1/1 agents done')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000) })
    expect(requests).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(requests).toHaveLength(2)
  })

  it('keeps fast recovery polling until live agents arrive', async () => {
    render(tray())
    requests[0].fail()
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(requests).toHaveLength(2)
  })

  it('fetches final disk results when completion races the initial request', async () => {
    startAgent()
    const view = render(tray())
    liveRun = { ...liveRun, completedAt: Date.now(), agents: { a1: { ...liveRun.agents.a1, status: 'done' } } }
    view.rerender(tray())
    expect(requests).toHaveLength(1)
    // This response began before completion and does not contain the final result.
    requests[0].resolve(emptyTree)
    await flush()
    expect(requests).toHaveLength(2)
    requests[1].resolve({
      ...emptyTree,
      agents: [{
        agentId: 'a1', label: 'search:reddit', phase: 'Research', status: 'done', result: 'Final evidence',
        resolved: 'prompt-regex', prompt: 'Full task', toolCount: 3, tokens: 500, durationMs: 1000, model: null,
      }],
    })
    await flush()
    expect(screen.getAllByTestId('workflow-agent-row')).toHaveLength(1)
    expect(screen.getByText('Final evidence')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(requests).toHaveLength(2)
  })
})
