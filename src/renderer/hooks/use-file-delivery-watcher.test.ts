// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const mockOpenFile = vi.fn()
let mockStreamingToolUses: Array<{ id: string; name: string; partialInput: string; ready?: boolean }> = []

vi.mock('./use-message-stream', () => ({
  useMessageStream: () => ({
    streamingToolUses: mockStreamingToolUses,
    isActive: false,
    isStreaming: false,
    streamingMessage: null,
    browserActive: false,
  }),
}))

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({
    openFile: mockOpenFile,
    openFiles: [],
    activeFileIndex: 0,
    comments: new Map(),
    isOpen: false,
    closeFile: vi.fn(),
    setActiveFile: vi.fn(),
    close: vi.fn(),
    addComment: vi.fn(),
    removeComment: vi.fn(),
    clearComments: vi.fn(),
  }),
}))

// Dynamic import so mocks are in place
async function getModule() {
  vi.resetModules()
  return import('./use-file-delivery-watcher')
}

describe('useFileDeliveryWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockOpenFile.mockClear()
    mockStreamingToolUses = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not open files from pre-existing tool calls on mount', async () => {
    mockStreamingToolUses = [{
      id: 'tool-1',
      name: 'mcp__user-input__deliver_file',
      partialInput: JSON.stringify({ filePath: '/workspace/old.pdf' }),
      ready: true,
    }]

    const { useFileDeliveryWatcher } = await getModule()
    renderHook(() => useFileDeliveryWatcher('session-1', 'agent-1'))

    // Before the 1s mount delay, files shouldn't be opened
    vi.advanceTimersByTime(500)
    expect(mockOpenFile).not.toHaveBeenCalled()
  })

  it('opens file after mount delay when new delivery arrives', async () => {
    const { useFileDeliveryWatcher } = await getModule()
    const { rerender } = renderHook(() => useFileDeliveryWatcher('session-1', 'agent-1'))

    // Wait past mount delay
    vi.advanceTimersByTime(1500)

    // Simulate a new file delivery
    mockStreamingToolUses = [{
      id: 'tool-new',
      name: 'mcp__user-input__deliver_file',
      partialInput: JSON.stringify({ filePath: '/workspace/report.pdf', description: 'Your report' }),
      ready: true,
    }]
    rerender()

    expect(mockOpenFile).toHaveBeenCalledWith('/workspace/report.pdf', 'agent-1', 'Your report')
  })

  it('does not reopen the same tool id twice', async () => {
    const { useFileDeliveryWatcher } = await getModule()
    const { rerender } = renderHook(() => useFileDeliveryWatcher('session-1', 'agent-1'))
    vi.advanceTimersByTime(1500)

    mockStreamingToolUses = [{
      id: 'tool-1',
      name: 'mcp__user-input__deliver_file',
      partialInput: JSON.stringify({ filePath: '/workspace/report.pdf' }),
      ready: true,
    }]
    rerender()
    rerender()
    rerender()

    expect(mockOpenFile).toHaveBeenCalledTimes(1)
  })

  it('ignores tool calls that are not ready', async () => {
    const { useFileDeliveryWatcher } = await getModule()
    const { rerender } = renderHook(() => useFileDeliveryWatcher('session-1', 'agent-1'))
    vi.advanceTimersByTime(1500)

    mockStreamingToolUses = [{
      id: 'tool-1',
      name: 'mcp__user-input__deliver_file',
      partialInput: JSON.stringify({ filePath: '/workspace/report.pdf' }),
      ready: false,
    }]
    rerender()

    expect(mockOpenFile).not.toHaveBeenCalled()
  })

  it('ignores non-deliver_file tool calls', async () => {
    const { useFileDeliveryWatcher } = await getModule()
    const { rerender } = renderHook(() => useFileDeliveryWatcher('session-1', 'agent-1'))
    vi.advanceTimersByTime(1500)

    mockStreamingToolUses = [{
      id: 'tool-1',
      name: 'Bash',
      partialInput: JSON.stringify({ command: 'ls' }),
      ready: true,
    }]
    rerender()

    expect(mockOpenFile).not.toHaveBeenCalled()
  })

  it('handles malformed partial JSON gracefully', async () => {
    const { useFileDeliveryWatcher } = await getModule()
    const { rerender } = renderHook(() => useFileDeliveryWatcher('session-1', 'agent-1'))
    vi.advanceTimersByTime(1500)

    mockStreamingToolUses = [{
      id: 'tool-1',
      name: 'mcp__user-input__deliver_file',
      partialInput: '{"filePath": "/workspace/rep',
      ready: true,
    }]
    rerender()

    expect(mockOpenFile).not.toHaveBeenCalled()
  })

  it('does nothing when agentSlug is null', async () => {
    const { useFileDeliveryWatcher } = await getModule()
    const { rerender } = renderHook(() => useFileDeliveryWatcher('session-1', null))
    vi.advanceTimersByTime(1500)

    mockStreamingToolUses = [{
      id: 'tool-1',
      name: 'mcp__user-input__deliver_file',
      partialInput: JSON.stringify({ filePath: '/workspace/report.pdf' }),
      ready: true,
    }]
    rerender()

    expect(mockOpenFile).not.toHaveBeenCalled()
  })
})
