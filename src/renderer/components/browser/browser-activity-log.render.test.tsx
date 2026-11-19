// @vitest-environment jsdom
//
// Render counts of the browser drawer's activity log, with the real
// useMessages, useMessageStream and query client underneath: the fake server
// answers every fetch with freshly parsed objects, as the network does, so a
// row that skips a re-render here does so because the query layer kept its
// tool call's identity, not because a mock handed the same object back.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

class MockEventSource {
  static instances: MockEventSource[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  url: string
  readyState = MockEventSource.OPEN
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  close() {
    this.readyState = MockEventSource.CLOSED
  }
}

vi.mock('@renderer/lib/env', () => ({ getApiBaseUrl: () => '' }))

// --- Fake server -----------------------------------------------------------

interface ServerToolCall {
  id: string
  name: string
  input?: Record<string, unknown>
  result?: unknown
  isError?: boolean
  subagent?: { agentId: string; status: string }
}
interface ServerMessage {
  id: string
  type: 'assistant' | 'user'
  content: { text: string }
  toolCalls?: ServerToolCall[]
}

const server = {
  messages: [] as ServerMessage[],
  subagents: {} as Record<string, ServerMessage[]>,
  /** Answer `?after=` with a delta window instead of a plain trailing page. */
  deltas: false,
}
const fetched: string[] = []

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (url: string) => {
    fetched.push(url)
    const subagent = url.match(/subagent\/([^/]+)\/messages/)
    let body: unknown
    if (subagent) {
      body = clone(server.subagents[subagent[1]] ?? [])
    } else {
      const after = new URL(url, 'http://test').searchParams.get('after')
      const from = after ? server.messages.findIndex((m) => m.id === after) : -1
      body = server.deltas && after && from >= 0
        ? { messages: clone(server.messages.slice(from)), anchor: after }
        : { messages: clone(server.messages), nextCursor: null }
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  },
}))

// --- Render probes ---------------------------------------------------------

// A row asks its renderer for a summary once per render, so the marker each
// input carries says which row rendered. The streaming row does the same with
// its parsed partial input.
const rowRenders: string[] = []
vi.mock('@shared/lib/tools/renderers', () => ({
  getToolRenderer: () => ({
    displayName: 'tool',
    getSummary: (input: { marker?: string } | undefined) => {
      rowRenders.push(input?.marker ?? '?')
      return input?.marker ?? null
    },
  }),
}))

const parseCalls: unknown[] = []
vi.mock('@renderer/lib/parse-tool-result', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/parse-tool-result')>()
  return {
    ...actual,
    parseToolResult: (result: unknown, ...rest: []) => {
      parseCalls.push(result)
      return actual.parseToolResult(result, ...rest)
    },
  }
})

// The log renders its ScrollArea every time it renders with anything to show.
let logRenders = 0
vi.mock('@renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, className }: any) => {
    logRenders++
    return <div className={className}>{children}</div>
  },
}))

vi.mock('lucide-react', () => ({
  Loader2: (props: any) => <span data-testid="icon-loader" {...props} />,
  ChevronRight: (props: any) => <span {...props} />,
  ChevronDown: (props: any) => <span {...props} />,
}))

const scrollIntoView = vi.fn()
Element.prototype.scrollIntoView = scrollIntoView

import { BrowserActivityLog } from './browser-activity-log'

// --- Helpers ---------------------------------------------------------------

const AGENT = 'agent-1'
let sessionCounter = 0
let sessionId = ''
let queryClient: QueryClient

function browserCall(id: string, extra: Partial<ServerToolCall> = {}): ServerToolCall {
  return { id, name: 'mcp__browser__click', input: { marker: id }, result: `result of ${id}`, ...extra }
}

function assistant(id: string, toolCalls: ServerToolCall[]): ServerMessage {
  return { id, type: 'assistant', content: { text: '' }, toolCalls }
}

function task(id: string, agentId: string): ServerMessage {
  return assistant(id, [{ id: `task-${id}`, name: 'Task', input: {}, subagent: { agentId, status: 'running' } }])
}

function send(data: Record<string, unknown>) {
  const source = MockEventSource.instances.find((es) => es.url.includes(sessionId) && es.readyState === MockEventSource.OPEN)
  if (!source) throw new Error('no open stream for the session')
  act(() => source.onmessage?.({ data: JSON.stringify(data) }))
}

function resetProbes() {
  rowRenders.length = 0
  parseCalls.length = 0
  logRenders = 0
  scrollIntoView.mockClear()
}

const rowLabels = () => screen.getAllByRole('button').map((button) => button.textContent)

async function mount() {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <BrowserActivityLog sessionId={sessionId} agentSlug={AGENT} />
    </QueryClientProvider>,
  )
  return view
}

// The query layer tells its observers on a later macrotask, so the refetch is
// given one to land before anything is counted.
async function refetch(queryKey: unknown[]) {
  const before = fetched.length
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey })
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(fetched.length).toBeGreaterThan(before)
}

const refetchMessages = () => refetch(['messages', sessionId])
const refetchSubagent = (agentId: string) => refetch(['subagent-messages', sessionId, AGENT, agentId])

const originalEventSource = globalThis.EventSource
const originalFetch = globalThis.fetch

beforeEach(() => {
  sessionId = `session-${++sessionCounter}`
  server.messages = []
  server.subagents = {}
  server.deltas = false
  fetched.length = 0
  MockEventSource.instances = []
  ;(globalThis as any).EventSource = MockEventSource
  globalThis.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ active: false }) }) as any
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  resetProbes()
})

afterEach(() => {
  queryClient.clear()
  ;(globalThis as any).EventSource = originalEventSource
  globalThis.fetch = originalFetch
})

/** A long session: 60 browser calls by the main agent, 60 by a subagent. */
function seedLongSession() {
  server.messages = [
    { id: 'u-0', type: 'user', content: { text: 'go' } },
    ...Array.from({ length: 60 }, (_, i) => assistant(`m-${i}`, [browserCall(`main-${i}`)])),
    task('m-task', 'sub-1'),
  ]
  server.subagents['sub-1'] = Array.from({ length: 60 }, (_, i) => assistant(`s-${i}`, [browserCall(`sub-${i}`)]))
}

async function mountLongSession() {
  seedLongSession()
  const view = await mount()
  await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(80))
  // A subagent is at work, as it is whenever the drawer is open.
  send({ type: 'session_active' })
  send({ type: 'subagent_started', parentToolId: 'task-m-task', agentId: 'sub-1', subagentType: 'web-browser' })
  send({ type: 'subagent_stream_start', parentToolId: 'task-m-task', agentId: 'sub-1' })
  resetProbes()
  return view
}

// --- Tests -----------------------------------------------------------------

describe('BrowserActivityLog renders', () => {
  it('does not render the log or any row for streamed tokens', async () => {
    await mountLongSession()

    send({ type: 'stream_start' })
    for (let i = 0; i < 50; i++) {
      send({ type: 'stream_delta', text: `main ${i} ` })
      send({ type: 'subagent_stream_delta', parentToolId: 'task-m-task', agentId: 'sub-1', text: `sub ${i} ` })
    }
    send({ type: 'subagent_progress', parentToolId: 'task-m-task', agentId: 'sub-1', summary: 'Reading the page', lastToolName: 'Read' })
    send({ type: 'tool_use_start', toolId: 'bash-1', toolName: 'Bash', partialInput: '' })
    send({ type: 'tool_use_streaming', toolId: 'bash-1', toolName: 'Bash', partialInput: '{"command":"ls"}' })
    send({ type: 'subagent_tool_use_start', parentToolId: 'task-m-task', agentId: 'sub-1', toolId: 'read-1', toolName: 'Read', partialInput: '' })
    send({ type: 'stream_end' })

    expect(logRenders).toBe(0)
    expect(rowRenders).toEqual([])
    expect(parseCalls).toEqual([])
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button')).toHaveLength(80)
  })

  it('does not render rows or parse results when a refetch brings nothing new', async () => {
    await mountLongSession()

    await refetchMessages()
    await refetchSubagent('sub-1')

    // The log itself may render (useMessages reports the fetch starting and
    // ending); what it must not do is reach a row.
    expect(rowRenders).toEqual([])
    expect(parseCalls).toEqual([])
  })

  it('does not render the log when only a subagent transcript refetches unchanged', async () => {
    await mountLongSession()

    await refetchSubagent('sub-1')

    expect(logRenders).toBe(0)
    expect(rowRenders).toEqual([])
  })

  it('parses no result for a closed row, and parses on open', async () => {
    server.messages = [assistant('m-0', [browserCall('a', { result: JSON.stringify([{ type: 'text', text: 'snapshot text' }]) })])]
    await mount()
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1))
    expect(parseCalls).toEqual([])

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('snapshot text')).toBeInTheDocument()
    expect(parseCalls).toHaveLength(1)

    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText('snapshot text')).not.toBeInTheDocument()
  })

  it('still opens a row that has a result but no input', async () => {
    server.messages = [assistant('m-0', [{ id: 'a', name: 'mcp__browser__snapshot', result: 'only a result' }])]
    await mount()
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1))

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('only a result')).toBeInTheDocument()
  })

  it.each([false, true])('renders only the new row when a browser tool call arrives (delta refetch: %s)', async (deltas) => {
    server.deltas = deltas
    await mountLongSession()

    server.messages.push(assistant('m-new', [browserCall('main-new', { result: undefined })]))
    await refetchMessages()

    expect(rowRenders).toEqual(['main-new'])
    expect(parseCalls).toEqual([])
    // Still capped, and the new call is in main-agent order, ahead of the subagent's.
    const labels = rowLabels()
    expect(labels).toHaveLength(80)
    expect(labels[19]).toContain('main-new')
    expect(labels[20]).toContain('sub-0')
  })

  it.each([false, true])('renders only its own row when a tool result arrives (delta refetch: %s)', async (deltas) => {
    server.deltas = deltas
    server.messages = [
      { id: 'u-0', type: 'user', content: { text: 'go' } },
      assistant('m-0', [browserCall('a')]),
      assistant('m-1', [browserCall('b')]),
      assistant('m-2', [browserCall('c', { result: undefined })]),
    ]
    await mount()
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(3))
    // Open the pending row: it has no result to show yet.
    fireEvent.click(screen.getAllByRole('button')[2])
    resetProbes()

    server.messages[3].toolCalls![0].result = 'page loaded'
    server.messages[3].toolCalls![0].isError = false
    await refetchMessages()

    expect(rowRenders).toEqual(['c'])
    expect(screen.getByText('page loaded')).toBeInTheDocument()
  })

  it('renders only its own row when a subagent tool result arrives', async () => {
    await mountLongSession()
    const call = server.subagents['sub-1'][59].toolCalls![0]
    call.result = 'changed'
    await refetchSubagent('sub-1')

    expect(rowRenders).toEqual(['sub-59'])
  })

  it('shows subagent browser activity after the main agent\'s, each in order, capped at 80', async () => {
    seedLongSession()
    server.subagents['sub-2'] = [assistant('t-0', [browserCall('other-0'), { id: 'x', name: 'Read', input: { marker: 'x' } }])]
    server.messages.push(task('m-task-2', 'sub-2'))
    await mount()
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(80))
    await waitFor(() => expect(rowLabels()[79]).toContain('other-0'))

    // 121 calls in all: the last 80 are main 41..59, sub 0..59, other 0.
    const expected = [
      ...Array.from({ length: 19 }, (_, i) => `main-${i + 41}`),
      ...Array.from({ length: 60 }, (_, i) => `sub-${i}`),
      'other-0',
    ]
    expect(rowLabels().map((label) => label?.replace('tool', ''))).toEqual(expected)
    expect(fetched.filter((url) => url.includes('/subagent/')).sort()).toEqual([
      `/api/agents/${AGENT}/sessions/${sessionId}/subagent/sub-1/messages`,
      `/api/agents/${AGENT}/sessions/${sessionId}/subagent/sub-2/messages`,
    ])
  })

  it('shows a subagent\'s streaming browser tool, renders only that row per input delta, and scrolls once', async () => {
    await mountLongSession()

    const frame = (partialInput: string) => ({
      type: 'subagent_tool_use_streaming', parentToolId: 'task-m-task', agentId: 'sub-1',
      toolId: 'live-1', toolName: 'mcp__browser__navigate', partialInput,
    })
    send({ ...frame(''), type: 'subagent_tool_use_start' })
    expect(screen.getByTestId('icon-loader')).toBeInTheDocument()
    send(frame('{"marker":"li'))
    send(frame('{"marker":"live"'))
    send(frame('{"marker":"live"}'))
    // Tokens between the deltas change nothing.
    send({ type: 'subagent_stream_delta', parentToolId: 'task-m-task', agentId: 'sub-1', text: 'thinking' })

    expect(rowRenders).toEqual(['live'])
    expect(logRenders).toBe(4)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('button')).toHaveLength(80)

    // Once the call is in the transcript, its row replaces the streaming one.
    resetProbes()
    server.subagents['sub-1'].push(assistant('s-live', [browserCall('live-1', { name: 'mcp__browser__navigate' })]))
    await refetchSubagent('sub-1')
    expect(screen.queryByTestId('icon-loader')).not.toBeInTheDocument()
    expect(rowRenders).toEqual(['live-1'])
    expect(rowLabels()[79]).toContain('live-1')
  })

  it('shows the main agent\'s streaming browser tool before any call is persisted, and drops it when the turn ends', async () => {
    await mount()
    await waitFor(() => expect(fetched.length).toBeGreaterThan(0))
    expect(screen.getByText('No browser activity yet')).toBeInTheDocument()

    send({ type: 'session_active' })
    send({ type: 'tool_use_start', toolId: 'live-1', toolName: 'mcp__browser__open', partialInput: '' })
    expect(screen.queryByText('No browser activity yet')).not.toBeInTheDocument()
    expect(screen.getByTestId('icon-loader')).toBeInTheDocument()

    send({ type: 'tool_use_streaming', toolId: 'live-1', toolName: 'mcp__browser__open', partialInput: '{"marker":"opening"}' })
    expect(screen.getByText('opening')).toBeInTheDocument()

    send({ type: 'session_idle' })
    await waitFor(() => expect(screen.getByText('No browser activity yet')).toBeInTheDocument())
    expect(screen.queryByTestId('icon-loader')).not.toBeInTheDocument()
  })

  it('skips a streaming tool that is already persisted and shows the next one', async () => {
    server.messages = [assistant('m-0', [browserCall('done-1')]), task('m-task', 'sub-1')]
    await mount()
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1))
    send({ type: 'session_active' })

    send({ type: 'tool_use_start', toolId: 'done-1', toolName: 'mcp__browser__click', partialInput: '{"marker":"stale"}' })
    expect(screen.queryByTestId('icon-loader')).not.toBeInTheDocument()

    send({
      type: 'subagent_tool_use_start', parentToolId: 'task-m-task', agentId: 'sub-1',
      toolId: 'live-2', toolName: 'mcp__browser__fill', partialInput: '{"marker":"next"}',
    })
    expect(screen.getByTestId('icon-loader')).toBeInTheDocument()
    expect(screen.getByText('next')).toBeInTheDocument()
    expect(screen.queryByText('stale')).not.toBeInTheDocument()
  })
})
