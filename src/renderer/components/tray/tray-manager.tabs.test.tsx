// @vitest-environment jsdom
// The drawer's one strip: pages, files, runs and the session's subagents as
// tabs of the same kind, what Hide keeps, and what a session gets back when it
// is reopened.
import { useEffect, type MutableRefObject } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TrayFocus } from '@renderer/lib/session-memory'

interface PagesStub {
  tabs: { targetId: string; index: number; url: string; title: string; active: boolean }[]
  viewingTargetId: string
}
const browser = {
  pages: {
    tabs: [
      { targetId: 't1', index: 0, url: 'https://alpha.example', title: 'Alpha', active: true },
      { targetId: 't2', index: 1, url: 'https://beta.example', title: 'Beta', active: false },
    ],
    viewingTargetId: 't1',
  } as PagesStub,
  actions: { select: vi.fn(), close: vi.fn() },
}
vi.mock('@renderer/components/browser/browser-tray-content', () => ({
  BrowserTrayContent: ({ visible, connected, onPagesChange, actionsRef }: {
    visible: boolean
    connected: boolean
    onPagesChange: (pages: PagesStub | null) => void
    actionsRef: MutableRefObject<typeof browser.actions | null>
  }) => {
    useEffect(() => {
      onPagesChange(browser.pages)
      actionsRef.current = browser.actions
      return () => onPagesChange(null)
    }, [onPagesChange, actionsRef])
    return <div data-testid="browser-body" data-visible={visible} data-connected={connected} />
  },
}))
vi.mock('@renderer/components/file-preview/file-preview-tray-content', () => ({
  FilePreviewTrayContent: () => <div data-testid="file-body" />,
}))
vi.mock('@renderer/components/workflow/workflow-tray-content', () => ({
  WorkflowTrayContent: ({ runId, agentId }: { runId: string; agentId?: string }) => (
    <div data-testid="workflow-body" data-run={runId} data-agent={agentId} />
  ),
}))
vi.mock('./subagents-tray-content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./subagents-tray-content')>()),
  SubagentsTrayContent: () => <div data-testid="subagents-body" />,
}))

const REPORT = { kind: 'file', filePath: '/workspace/report.md', agentSlug: 'a', displayName: 'report.md', version: 1, pdfPage: 1 }
const REPORT_KEY = 'file:a:/workspace/report.md'
const files = {
  openTabs: [] as unknown[],
  activeTabIndex: 0,
  isOpen: false,
  focus: null as TrayFocus | null,
  close: vi.fn(),
  setActiveTab: vi.fn(),
  closeTab: vi.fn(),
  openFolder: vi.fn(),
  openFile: vi.fn(),
}
const work = {
  openWorkflows: [] as { runId: string; name?: string; agentId?: string }[],
  subagents: { open: false, viewing: null as { id: string } | null },
  focus: null as TrayFocus | null,
  closeWorkflow: vi.fn(),
  closeSubagents: vi.fn(),
  openSubagent: vi.fn(),
  openSubagents: vi.fn(),
  background: { open: false, viewing: null as string | null },
  closeBackgroundTasks: vi.fn(),
  openBackgroundTasks: vi.fn(),
  agentSessions: { open: false, viewing: null as { slug: string; sessionId: string } | null },
  closeAgentSessions: vi.fn(),
  openAgentSessions: vi.fn(),
}
vi.mock('@renderer/context/file-preview-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/context/file-preview-context')>()),
  useFilePreview: () => files,
}))
vi.mock('@renderer/context/workflow-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/context/workflow-context')>()),
  useWorkflow: () => work,
}))
// The session's transcript, for the New tab's list of the session's files.
const transcript = { messages: [] as unknown[] }
vi.mock('@renderer/hooks/use-messages', () => ({ useMessages: () => ({ data: transcript.messages }) }))
vi.mock('@renderer/hooks/use-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/hooks/use-agents')>()),
  useAgents: () => ({ data: [{ slug: 'helper', name: 'Helper' }] }),
  useAgent: () => ({ data: null }),
}))
vi.mock('./agent-sessions-tray-content', () => ({
  AgentSessionsLiveDot: () => null,
  AgentSessionsTrayContent: () => <div data-testid="agent-sessions-body" />,
}))
vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ workflows: [], activeSubagents: [], completedSubagents: null, isActive: false }),
}))
const pending = { requests: [] as unknown[] }
vi.mock('@shared/lib/tools/requests/use-pending-user-requests', () => ({
  usePendingUserRequests: () => ({ data: pending.requests }),
}))
vi.mock('@renderer/components/ui/sidebar', () => ({ useSidebar: () => ({ open: true, setOpen: vi.fn() }) }))
// Where the view's header keeps the drawer's toggle; null where the header has none.
const header = { slot: null as HTMLElement | null }
vi.mock('@renderer/components/layout/content-shell', () => ({ useHeaderTraySlot: () => header.slot }))

import { TrayManager, neighbourOf, placeNewTabs } from './tray-manager'

async function flushFrames() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  })
}

function tabKeys() {
  return Array.from(screen.getByTestId('tray-tab-bar').querySelectorAll('[data-tray-tab]')).map((tab) => tab.getAttribute('data-tray-tab'))
}
function frontKey() {
  return screen.getByTestId('tray-tab-bar').querySelector('[data-tray-tab][data-active]')?.getAttribute('data-tray-tab')
}

function openEverything() {
  files.isOpen = true
  files.openTabs = [REPORT]
  work.openWorkflows = [{ runId: 'wf1', name: 'Deep dive', agentId: 'a7' }]
  work.subagents = { open: true, viewing: null }
}

describe('TrayManager tabs', () => {
  beforeEach(() => {
    localStorage.clear()
    files.openTabs = []
    files.activeTabIndex = 0
    files.isOpen = false
    files.focus = null
    files.close.mockClear()
    files.setActiveTab.mockClear()
    work.openWorkflows = []
    work.subagents = { open: false, viewing: null }
    work.focus = null
    work.agentSessions = { open: false, viewing: null }
    work.openSubagent.mockClear()
    work.openSubagents.mockClear()
    files.openFolder.mockClear()
    files.openFile.mockClear()
    transcript.messages = []
    browser.actions.select.mockClear()
    pending.requests = []
    header.slot?.remove()
    header.slot = null
  })

  it('lists pages, a file, a run and the subagents in one strip, and moves between them without closing the drawer', async () => {
    openEverything()
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="tabs-1" browserActive persistent />)
    await flushFrames()

    // One strip, in opening order: the browser's pages hold the place its placeholder took.
    expect(tabKeys()).toEqual(['browser:t1', 'browser:t2', REPORT_KEY, 'workflow:wf1', 'agent:subagents'])
    // The page the agent is on is live and cannot be closed; the other page can.
    const pages = screen.getAllByTestId('browser-tab')
    expect(pages[0].querySelector('[data-testid="tray-tab-live"]')).not.toBeNull()
    expect(pages[0].querySelector('[data-testid="browser-tab-close"]')).toBeNull()
    expect(pages[1].querySelector('[data-testid="browser-tab-close"]')).not.toBeNull()

    // The browser came up, so its page is in front.
    expect(frontKey()).toBe('browser:t1')
    expect(screen.getByTestId('browser-body')).toHaveAttribute('data-visible', 'true')

    await user.click(screen.getByTestId('file-tab-select'))
    expect(files.setActiveTab).toHaveBeenCalledWith(0)
    expect(frontKey()).toBe(REPORT_KEY)
    expect(screen.getByTestId('file-body')).toBeInTheDocument()
    // The browser stays mounted behind the file, so it does not start over on the way back.
    expect(screen.getByTestId('browser-body')).toHaveAttribute('data-visible', 'false')

    await user.click(screen.getByTestId('workflow-tab-select'))
    // The run's tab shows whichever of its agents was picked; that is the tab's own business.
    expect(screen.getByTestId('workflow-body')).toHaveAttribute('data-run', 'wf1')
    expect(screen.getByTestId('workflow-body')).toHaveAttribute('data-agent', 'a7')
    // Every subagent shares the one tab.
    expect(screen.getAllByTestId('agent-tab')).toHaveLength(1)
    expect(screen.getByTestId('agent-tab')).toHaveTextContent('Subagents')
    await user.click(screen.getByTestId('agent-tab-select'))
    expect(screen.getByTestId('subagents-body')).toBeInTheDocument()

    await user.click(screen.getAllByTestId('browser-tab-select')[1])
    expect(browser.actions.select).toHaveBeenCalledWith('t2')
    expect(screen.getByTestId('tray-drawer')).not.toHaveClass('hidden')
  })

  it('stands the tabs on the page above one card holding the front tab\'s body', async () => {
    openEverything()
    render(<TrayManager agentSlug="a" sessionId="tabs-card" browserActive persistent />)
    await flushFrames()
    const panel = screen.getByTestId('tray-panel')
    expect(panel).toContainElement(screen.getByTestId('browser-body'))
    expect(panel).not.toContainElement(screen.getByTestId('tray-tab-bar'))
    expect(panel.previousElementSibling).toBe(screen.getByTestId('tray-tab-bar'))
    expect(panel).toHaveClass('rounded-card', 'border')
  })

  it('opens a New tab from +, which gives way to whatever is picked in it', async () => {
    files.isOpen = true
    files.openTabs = [REPORT]
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="tabs-new" browserActive={false} persistent />)
    await flushFrames()

    // Until the tabs overflow, + follows the last tab inside the strip's scrolling group.
    expect(screen.getByTestId('tray-tab-group')).toContainElement(screen.getByTestId('tray-new-tab'))
    expect(screen.getByTestId('tray-controls')).not.toContainElement(screen.getByTestId('tray-new-tab'))
    await user.click(screen.getByRole('button', { name: 'New tab' }))
    // It goes to the end of the row and to the front, showing the launcher.
    expect(tabKeys()).toEqual([REPORT_KEY, 'new:1'])
    expect(frontKey()).toBe('new:1')
    // + again opens another, from a New tab too, as in a browser.
    await user.click(screen.getByTestId('tray-new-tab'))
    expect(tabKeys()).toEqual([REPORT_KEY, 'new:1', 'new:2'])
    expect(frontKey()).toBe('new:2')

    // Picking in one gives way only to it; the other New tab stays.
    await user.click(screen.getByTestId('tray-empty-subagents'))
    expect(work.openSubagents).toHaveBeenCalledTimes(1)
    expect(tabKeys()).toEqual([REPORT_KEY, 'new:1'])
  })

  it('lists the session\'s files in the New tab, and opens one in its place', async () => {
    transcript.messages = [{
      type: 'assistant',
      id: 'm1',
      toolCalls: [{ id: 't1', name: 'mcp__user-input__deliver_file', input: { filePath: '/workspace/report.md', description: 'The report' }, result: 'ok' }],
    }]
    files.isOpen = true
    files.openTabs = [REPORT]
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="tabs-new-files" browserActive={false} persistent />)
    await flushFrames()
    await user.click(screen.getByTestId('tray-new-tab'))
    const section = screen.getByTestId('tray-session-files')
    expect(screen.getByTestId('tray-session-assets')).toHaveTextContent('Session files')
    expect(section).toHaveAccessibleName('Files')
    await user.click(within(section).getByRole('button', { name: /report\.md/ }))
    expect(files.openFile).toHaveBeenCalledWith('/workspace/report.md', 'a', 'The report')
    expect(tabKeys()).toEqual([REPORT_KEY])
  })

  it('shows the session\'s pictures and videos as thumbnails and the rest as rows', async () => {
    transcript.messages = [{
      type: 'assistant',
      id: 'm1',
      toolCalls: [
        { id: 't1', name: 'Write', input: { file_path: '/workspace/chart.png' } },
        { id: 't2', name: 'Write', input: { file_path: '/workspace/demo.mp4' } },
        { id: 't3', name: 'Write', input: { file_path: '/workspace/notes.md' } },
      ],
    }]
    files.isOpen = true
    files.openTabs = [REPORT]
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="tabs-new-media" browserActive={false} persistent />)
    await flushFrames()
    await user.click(screen.getByTestId('tray-new-tab'))
    const media = screen.getByTestId('tray-session-media')
    expect(media).toHaveAccessibleName('Images and videos')
    expect(within(media).getAllByTestId('tray-session-thumbnail').map(button => button.getAttribute('aria-label'))).toEqual(['demo.mp4', 'chart.png'])
    expect(media.querySelector('img')).not.toBeNull()
    expect(media.querySelector('video')).not.toBeNull()
    const others = screen.getByTestId('tray-session-files')
    expect(others).toHaveAccessibleName('Files')
    expect(within(others).getAllByTestId('tray-session-file')).toHaveLength(1)
    expect(others).toHaveTextContent('notes.md')
  })

  it('counts what the session has had on the Subagents and Invoked agents tiles, quietly and only once there is one', async () => {
    transcript.messages = [{
      type: 'assistant',
      id: 'm1',
      toolCalls: [
        { id: 't1', name: 'Agent', input: { description: 'Look around' } },
        { id: 't2', name: 'Agent', input: { description: 'Look again' } },
        { id: 't3', name: 'mcp__agents__invoke_agent', input: { slug: 'helper', prompt: 'Hi' }, result: 'session_id: s1\nstatus: running' },
      ],
    }]
    files.isOpen = true
    files.openTabs = [REPORT]
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="tabs-new-counts" browserActive={false} persistent />)
    await flushFrames()
    await user.click(screen.getByTestId('tray-new-tab'))
    expect(within(screen.getByTestId('tray-empty-subagents')).getByTestId('tray-tile-count')).toHaveTextContent('2')
    expect(within(screen.getByTestId('tray-empty-agent-sessions')).getByTestId('tray-tile-count')).toHaveTextContent('1')
    expect(within(screen.getByTestId('tray-empty-background')).queryByTestId('tray-tile-count')).toBeNull()
  })

  it('opens the Invoked agents tab from its New tab tile', async () => {
    files.isOpen = true
    files.openTabs = [REPORT]
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="tabs-new-peers" browserActive={false} persistent />)
    await flushFrames()
    await user.click(screen.getByTestId('tray-new-tab'))
    await user.click(screen.getByTestId('tray-empty-agent-sessions'))
    expect(work.openAgentSessions).toHaveBeenCalled()
  })

  it('gives every session this one called one shared Invoked agents tab, as Subagents has', async () => {
    work.agentSessions = { open: true, viewing: null }
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="tabs-call" browserActive={false} persistent />)
    await flushFrames()
    expect(tabKeys()).toEqual(['agent:sessions'])
    expect(screen.getByTestId('call-tab')).toHaveTextContent('Invoked agents')
    expect(screen.getByTestId('agent-sessions-body')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close Invoked agents' }))
    expect(work.closeAgentSessions).toHaveBeenCalled()
  })

  it('closes a New tab like any other', async () => {
    files.isOpen = true
    files.openTabs = [REPORT]
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="tabs-new-close" browserActive={false} persistent />)
    await flushFrames()
    await user.click(screen.getByTestId('tray-new-tab'))
    await user.click(screen.getByRole('button', { name: 'Close New tab' }))
    expect(tabKeys()).toEqual([REPORT_KEY])
    expect(frontKey()).toBe(REPORT_KEY)
  })

  it('keeps every tab behind Hide, and opening something brings the drawer back', async () => {
    openEverything()
    const user = userEvent.setup()
    const { rerender } = render(<TrayManager agentSlug="a" sessionId="tabs-2" browserActive persistent />)
    await flushFrames()

    await user.click(screen.getByRole('button', { name: 'Hide panel' }))
    expect(screen.getByTestId('tray-drawer')).toHaveClass('hidden')
    // The toggle shows only its icon; its label still says what is behind it.
    expect(screen.getByRole('button', { name: 'Show panel, 5 tabs' })).not.toHaveTextContent(/\d/)
    // Hidden, the browser's stream is let go but its body is kept.
    expect(screen.getByTestId('browser-body')).toHaveAttribute('data-connected', 'false')
    expect(files.close).not.toHaveBeenCalled()

    // Clicking a file in the chat asks for its tab.
    files.focus = { key: REPORT_KEY, seq: 1 }
    rerender(<TrayManager agentSlug="a" sessionId="tabs-2" browserActive persistent />)
    await flushFrames()
    expect(screen.getByTestId('tray-drawer')).not.toHaveClass('hidden')
    expect(frontKey()).toBe(REPORT_KEY)
    expect(screen.queryByTestId('tray-show')).toBeNull()
  })

  it('puts its one toggle in the header where the header has a place for it', async () => {
    header.slot = document.body.appendChild(document.createElement('div'))
    openEverything()
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="tabs-header" browserActive persistent />)
    await flushFrames()

    // Open: the header button is lit, and the strip does not repeat it.
    const hide = screen.getByRole('button', { name: 'Hide panel' })
    expect(header.slot).toContainElement(hide)
    expect(hide).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('tray-controls').querySelector('[aria-label="Hide panel"]')).toBeNull()
    // Full screen stays with the strip.
    expect(screen.getByTestId('tray-controls').querySelector('[data-testid="tray-fullscreen"]')).not.toBeNull()

    await user.click(hide)
    expect(screen.getByTestId('tray-drawer')).toHaveClass('hidden')
    // Hidden: the same button brings it back, and says what is waiting.
    const show = screen.getByRole('button', { name: 'Show panel, 5 tabs' })
    expect(header.slot).toContainElement(show)
    expect(show).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getAllByTestId('tray-show')).toHaveLength(1)

    await user.click(show)
    await flushFrames()
    expect(screen.getByTestId('tray-drawer')).not.toHaveClass('hidden')
  })

  it('always shows the header toggle, and opens a New tab while there are no tabs', async () => {
    header.slot = document.body.appendChild(document.createElement('div'))
    transcript.messages = [{ type: 'assistant', id: 'm1', toolCalls: [{ id: 't1', name: 'Write', input: { file_path: '/workspace/report.md' } }] }]
    const user = userEvent.setup()
    const { rerender } = render(<TrayManager agentSlug="a" sessionId="tabs-empty" browserActive={false} persistent />)
    await flushFrames()

    // Nothing is open, so the drawer is closed, but its toggle is there.
    expect(screen.queryByTestId('tray-drawer')).toBeNull()
    const show = screen.getByRole('button', { name: 'Show panel' })
    expect(header.slot).toContainElement(show)
    expect(show.textContent).toBe('')

    // Opening it opens a New tab.
    await user.click(show)
    await flushFrames()
    expect(tabKeys()).toEqual(['new:1'])
    expect(screen.getByTestId('tray-new-tab-body')).toHaveTextContent('Session utilities')

    // Picking one of the session's files gives the New tab's place to it.
    await user.click(screen.getByTestId('tray-session-file'))
    expect(files.openFile).toHaveBeenCalledWith('/workspace/report.md', 'a', undefined)
    expect(screen.queryByTestId('tray-drawer')).toBeNull()

    // The file the pick opened shows up as the drawer's tab.
    files.isOpen = true
    files.openTabs = [REPORT]
    rerender(<TrayManager agentSlug="a" sessionId="tabs-empty" browserActive={false} persistent />)
    await flushFrames()
    expect(tabKeys()).toEqual([REPORT_KEY])
    expect(screen.getByTestId('file-body')).toBeInTheDocument()
  })

  it('closes the drawer when its only tab, a New tab, is closed', async () => {
    header.slot = document.body.appendChild(document.createElement('div'))
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="tabs-empty-close" browserActive={false} persistent />)
    await flushFrames()
    await user.click(screen.getByRole('button', { name: 'Show panel' }))
    await user.click(screen.getByRole('button', { name: 'Close New tab' }))
    expect(screen.queryByTestId('tray-drawer')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show panel' })).toBeInTheDocument()
  })

  it('shows nothing at all with no tabs where the header has no toggle', async () => {
    const { container } = render(<TrayManager agentSlug="a" sessionId="tabs-none" browserActive={false} persistent />)
    await flushFrames()
    expect(container).toBeEmptyDOMElement()
  })

  it('brings a hidden drawer back on the tab it was left on', async () => {
    openEverything()
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="tabs-3" browserActive persistent />)
    await flushFrames()
    await user.click(screen.getByTestId('workflow-tab-select'))
    await user.click(screen.getByRole('button', { name: 'Hide panel' }))
    await user.click(screen.getByTitle('Show panel'))
    await flushFrames()
    expect(frontKey()).toBe('workflow:wf1')
  })

  it('closes a preview drawer outright when it is hidden', async () => {
    files.isOpen = true
    files.openTabs = [REPORT]
    const user = userEvent.setup()
    render(<TrayManager agentSlug="a" sessionId="home-preview" browserActive={false} />)
    await flushFrames()
    await user.click(screen.getByRole('button', { name: 'Hide panel' }))
    expect(files.close).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('tray-show')).toBeNull()
  })

  it('opens the Subagents tab on a subagent that is waiting on the person, once per request', async () => {
    pending.requests = [
      { id: 'request-1', blocking: true, parentToolUseId: 'tool-9' },
      { id: 'request-2', blocking: true },
      { id: 'request-3', blocking: false, parentToolUseId: 'tool-7' },
      // Answered on the page itself, so the browser keeps the front.
      { id: 'request-4', blocking: true, parentToolUseId: 'tool-5', kind: 'browser_input' },
    ]
    const { rerender } = render(<TrayManager agentSlug="a" sessionId="tabs-4" browserActive={false} persistent />)
    await flushFrames()
    expect(work.openSubagent).toHaveBeenCalledTimes(1)
    expect(work.openSubagent).toHaveBeenCalledWith({ id: 'tool-9', name: 'Agent', input: {} })

    // The request is still open on the next snapshot: its tab is not asked for again.
    pending.requests = [...pending.requests]
    rerender(<TrayManager agentSlug="a" sessionId="tabs-4" browserActive={false} persistent />)
    await flushFrames()
    expect(work.openSubagent).toHaveBeenCalledTimes(1)
  })

  it('puts a session\'s drawer back as it was left', async () => {
    openEverything()
    const user = userEvent.setup()
    const { rerender } = render(<TrayManager agentSlug="a" sessionId="memory-1" browserActive persistent />)
    await flushFrames()
    await user.click(screen.getByTestId('agent-tab-select'))
    expect(frontKey()).toBe('agent:subagents')

    // Another session, then back. The browser is still up, and must not take the front again.
    rerender(<TrayManager agentSlug="a" sessionId="memory-2" browserActive persistent />)
    await flushFrames()
    rerender(<TrayManager agentSlug="a" sessionId="memory-1" browserActive persistent />)
    await flushFrames()
    expect(frontKey()).toBe('agent:subagents')
    expect(tabKeys()).toEqual(['browser:t1', 'browser:t2', REPORT_KEY, 'workflow:wf1', 'agent:subagents'])
  })
})

describe('placeNewTabs', () => {
  it('keeps placed tabs where they are and adds new ones at the end', () => {
    expect(placeNewTabs(['a', 'b'], ['b', 'c', 'a'])).toEqual(['a', 'b', 'c'])
  })

  it('returns the same order when nothing is new, including while a tab is away', () => {
    const order = ['a', 'b']
    expect(placeNewTabs(order, ['b'])).toBe(order)
  })

  it('gives the browser\'s first pages the place its placeholder held', () => {
    expect(placeNewTabs(['browser:pending', 'file:x'], ['browser:t1', 'browser:t2', 'file:x', 'workflow:w']))
      .toEqual(['browser:t1', 'browser:t2', 'file:x', 'workflow:w'])
  })
})

describe('neighbourOf', () => {
  const present = (keys: string[]) => (key: string) => keys.includes(key)

  it('picks the next tab along, then the one before', () => {
    expect(neighbourOf(['a', 'b', 'c'], 'b', present(['a', 'c']))).toBe('c')
    expect(neighbourOf(['a', 'b', 'c'], 'c', present(['a', 'b']))).toBe('b')
  })

  it('falls back to the last tab when the missing one was never placed', () => {
    expect(neighbourOf(['a', 'b'], 'gone', present(['a', 'b']))).toBe('b')
    expect(neighbourOf([], null, present([]))).toBeNull()
  })
})
