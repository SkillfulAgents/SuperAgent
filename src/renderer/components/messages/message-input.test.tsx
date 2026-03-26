// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MessageInput } from './message-input'
import { renderWithProviders } from '@renderer/test/test-utils'

// Mock hooks
const mockSendMessage = {
  mutateAsync: vi.fn().mockResolvedValue({}),
  isPending: false,
}
const mockUploadFile = { mutateAsync: vi.fn().mockResolvedValue({ path: '/tmp/file' }) }
const mockUploadFolder = { mutateAsync: vi.fn().mockResolvedValue({ path: '/tmp/folder' }) }
const mockInterruptSession = {
  mutateAsync: vi.fn().mockResolvedValue({}),
  isPending: false,
}

vi.mock('@renderer/hooks/use-messages', () => ({
  useSendMessage: () => mockSendMessage,
  useUploadFile: () => mockUploadFile,
  useUploadFolder: () => mockUploadFolder,
  useInterruptSession: () => mockInterruptSession,
}))

const mockStreamState = {
  isActive: false,
  slashCommands: [] as Array<{ name: string; description: string; argumentHint: string }>,
}

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => mockStreamState,
}))

// Mock useIsOnline — default online, override per test
let mockIsOnline = true
vi.mock('@renderer/context/connectivity-context', () => ({
  useIsOnline: () => mockIsOnline,
  ConnectivityProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('MessageInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStreamState.isActive = false
    mockStreamState.slashCommands = []
    mockSendMessage.isPending = false
    mockIsOnline = true
  })

  it('renders textarea with placeholder', () => {
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByTestId('message-input')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Type a message...')).toBeInTheDocument()
  })

  it('shows a disabled send button when idle and empty', () => {
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByTestId('send-button')).toBeDisabled()
  })

  it('shows stop button when session is active', () => {
    mockStreamState.isActive = true
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByTestId('stop-button')).toBeInTheDocument()
  })

  it('shows "Agent is responding..." placeholder when active', () => {
    mockStreamState.isActive = true
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByPlaceholderText('Agent is responding...')).toBeInTheDocument()
  })

  it('disables input when session is active', () => {
    mockStreamState.isActive = true
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByTestId('message-input')).toBeDisabled()
  })

  it('submits message on Enter key', async () => {
    const user = userEvent.setup()
    const onMessageSent = vi.fn()
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" onMessageSent={onMessageSent} />
    )

    const input = screen.getByTestId('message-input')
    await user.type(input, 'Hello world')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(onMessageSent).toHaveBeenCalledWith('Hello world')
    })
    await waitFor(() => {
      expect(mockSendMessage.mutateAsync).toHaveBeenCalledWith({
        sessionId: 's-1',
        agentSlug: 'agent-1',
        content: 'Hello world',
      })
    })
  })

  it('does not submit on Shift+Enter', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )

    const input = screen.getByTestId('message-input')
    await user.type(input, 'Hello')
    await user.keyboard('{Shift>}{Enter}{/Shift}')

    expect(mockSendMessage.mutateAsync).not.toHaveBeenCalled()
  })

  it('clears input after sending', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )

    const input = screen.getByTestId('message-input')
    await user.type(input, 'Hello')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(input).toHaveValue('')
    })
  })

  it('enables the send button after the user types', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )

    const input = screen.getByTestId('message-input')
    await user.type(input, 'Hello')

    expect(screen.getByTestId('send-button')).toBeEnabled()
  })

  it('submits message on send button click', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )

    const input = screen.getByTestId('message-input')
    await user.type(input, 'Hello by button')
    await user.click(screen.getByTestId('send-button'))

    await waitFor(() => {
      expect(mockSendMessage.mutateAsync).toHaveBeenCalledWith({
        sessionId: 's-1',
        agentSlug: 'agent-1',
        content: 'Hello by button',
      })
    })
  })

  it('calls interrupt on stop button click', async () => {
    const user = userEvent.setup()
    mockStreamState.isActive = true
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )

    await user.click(screen.getByTestId('stop-button'))
    expect(mockInterruptSession.mutateAsync).toHaveBeenCalledWith({
      sessionId: 's-1',
      agentSlug: 'agent-1',
    })
  })

  describe('slash command menu', () => {
    beforeEach(() => {
      mockStreamState.slashCommands = [
        { name: 'deploy', description: 'Deploy the app', argumentHint: '<env>' },
        { name: 'status', description: 'Show status', argumentHint: '' },
      ]
      // jsdom doesn't have scrollIntoView
      Element.prototype.scrollIntoView = vi.fn()
    })

    it('opens slash command menu when typing /', async () => {
      const user = userEvent.setup()
      renderWithProviders(
        <MessageInput sessionId="s-1" agentSlug="agent-1" />
      )

      const input = screen.getByTestId('message-input')
      await user.type(input, '/')

      await waitFor(() => {
        expect(screen.getByRole('listbox')).toBeInTheDocument()
      })
    })

    it('filters commands as user types', async () => {
      const user = userEvent.setup()
      renderWithProviders(
        <MessageInput sessionId="s-1" agentSlug="agent-1" />
      )

      const input = screen.getByTestId('message-input')
      await user.type(input, '/de')

      await waitFor(() => {
        const options = screen.getAllByRole('option')
        expect(options).toHaveLength(1)
      })
    })

    it('closes menu on Escape', async () => {
      const user = userEvent.setup()
      renderWithProviders(
        <MessageInput sessionId="s-1" agentSlug="agent-1" />
      )

      const input = screen.getByTestId('message-input')
      await user.type(input, '/')

      await waitFor(() => {
        expect(screen.getByRole('listbox')).toBeInTheDocument()
      })

      await user.keyboard('{Escape}')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('selects command on Enter', async () => {
      const user = userEvent.setup()
      renderWithProviders(
        <MessageInput sessionId="s-1" agentSlug="agent-1" />
      )

      const input = screen.getByTestId('message-input')
      await user.type(input, '/')

      await waitFor(() => {
        expect(screen.getByRole('listbox')).toBeInTheDocument()
      })

      await user.keyboard('{Enter}')

      await waitFor(() => {
        expect(input).toHaveValue('/deploy ')
      })
    })

    it('navigates with arrow keys', async () => {
      const user = userEvent.setup()
      renderWithProviders(
        <MessageInput sessionId="s-1" agentSlug="agent-1" />
      )

      const input = screen.getByTestId('message-input')
      await user.type(input, '/')

      await waitFor(() => {
        expect(screen.getByRole('listbox')).toBeInTheDocument()
      })

      // First item selected by default
      let options = screen.getAllByRole('option')
      expect(options[0]).toHaveAttribute('aria-selected', 'true')

      // Arrow down to next
      await user.keyboard('{ArrowDown}')
      options = screen.getAllByRole('option')
      expect(options[1]).toHaveAttribute('aria-selected', 'true')

      // Select with Enter
      await user.keyboard('{Enter}')
      await waitFor(() => {
        expect(input).toHaveValue('/status ')
      })
    })
  })

  it('has attach file button', () => {
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByTitle('Add files')).toBeInTheDocument()
  })

  // ---- Offline state ----

  describe('offline state', () => {
    beforeEach(() => {
      mockIsOnline = false
    })

    it('shows "No internet connection..." placeholder when offline', () => {
      renderWithProviders(
        <MessageInput sessionId="s-1" agentSlug="agent-1" />
      )
      expect(screen.getByPlaceholderText('No internet connection...')).toBeInTheDocument()
    })

    it('disables input when offline', () => {
      renderWithProviders(
        <MessageInput sessionId="s-1" agentSlug="agent-1" />
      )
      expect(screen.getByTestId('message-input')).toBeDisabled()
    })

    it('shows offline warning message', () => {
      renderWithProviders(
        <MessageInput sessionId="s-1" agentSlug="agent-1" />
      )
      expect(screen.getByText('No internet connection. Messages cannot be sent.')).toBeInTheDocument()
    })

    it('does not show offline warning when active (even if offline)', () => {
      mockStreamState.isActive = true
      renderWithProviders(
        <MessageInput sessionId="s-1" agentSlug="agent-1" />
      )
      // The warning only shows when !isActive && isOffline
      expect(screen.queryByText('No internet connection. Messages cannot be sent.')).not.toBeInTheDocument()
    })

    it('disables attach file button when offline', () => {
      renderWithProviders(
        <MessageInput sessionId="s-1" agentSlug="agent-1" />
      )
      expect(screen.getByTitle('Add files')).toBeDisabled()
    })
  })

  // ---- Whitespace-only input ----

  it('does not submit whitespace-only message', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )

    const input = screen.getByTestId('message-input')
    await user.type(input, '   ')
    await user.keyboard('{Enter}')

    expect(mockSendMessage.mutateAsync).not.toHaveBeenCalled()
  })

  it('send button stays disabled with whitespace-only text', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )

    const input = screen.getByTestId('message-input')
    await user.type(input, '   ')

    expect(screen.getByTestId('send-button')).toBeDisabled()
  })

  // ---- Tab key for slash command selection ----

  describe('slash command Tab selection', () => {
    beforeEach(() => {
      mockStreamState.slashCommands = [
        { name: 'deploy', description: 'Deploy the app', argumentHint: '<env>' },
        { name: 'status', description: 'Show status', argumentHint: '' },
      ]
      Element.prototype.scrollIntoView = vi.fn()
    })

    it('selects command on Tab key', async () => {
      const user = userEvent.setup()
      renderWithProviders(
        <MessageInput sessionId="s-1" agentSlug="agent-1" />
      )

      const input = screen.getByTestId('message-input')
      await user.type(input, '/')

      await waitFor(() => {
        expect(screen.getByRole('listbox')).toBeInTheDocument()
      })

      await user.keyboard('{Tab}')

      await waitFor(() => {
        expect(input).toHaveValue('/deploy ')
      })
    })
  })

  // ---- Slash menu does not open for non-slash messages ----

  it('does not open slash menu for normal text containing /', async () => {
    mockStreamState.slashCommands = [
      { name: 'deploy', description: 'Deploy', argumentHint: '' },
    ]
    const user = userEvent.setup()
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )

    const input = screen.getByTestId('message-input')
    await user.type(input, 'hello /deploy')

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  // ---- File drag-and-drop ----

  describe('file drag-and-drop', () => {
    it('shows drag overlay on dragOver', async () => {
      const { container } = renderWithProviders(
        <MessageInput sessionId="s-1" agentSlug="agent-1" />
      )

      const form = container.querySelector('form')!

      await act(async () => {
        const dragOverEvent = new Event('dragover', { bubbles: true })
        Object.defineProperty(dragOverEvent, 'preventDefault', { value: vi.fn() })
        Object.defineProperty(dragOverEvent, 'stopPropagation', { value: vi.fn() })
        form.dispatchEvent(dragOverEvent)
      })

      // The form should have ring-2 class when isDragOver
      expect(form.className).toContain('ring-2')
    })

    it('removes drag overlay on dragLeave', async () => {
      const { container } = renderWithProviders(
        <MessageInput sessionId="s-1" agentSlug="agent-1" />
      )

      const form = container.querySelector('form')!

      // First dragover
      await act(async () => {
        const dragOverEvent = new Event('dragover', { bubbles: true })
        Object.defineProperty(dragOverEvent, 'preventDefault', { value: vi.fn() })
        Object.defineProperty(dragOverEvent, 'stopPropagation', { value: vi.fn() })
        form.dispatchEvent(dragOverEvent)
      })

      expect(form.className).toContain('ring-2')

      // Then dragleave
      await act(async () => {
        const dragLeaveEvent = new Event('dragleave', { bubbles: true })
        Object.defineProperty(dragLeaveEvent, 'preventDefault', { value: vi.fn() })
        Object.defineProperty(dragLeaveEvent, 'stopPropagation', { value: vi.fn() })
        form.dispatchEvent(dragLeaveEvent)
      })

      expect(form.className).not.toContain('ring-2')
    })
  })

  // ---- Submit sends trimmed content ----

  it('trims whitespace from message before sending', async () => {
    const user = userEvent.setup()
    const onMessageSent = vi.fn()
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" onMessageSent={onMessageSent} />
    )

    const input = screen.getByTestId('message-input')
    await user.type(input, '  Hello  ')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(onMessageSent).toHaveBeenCalledWith('Hello')
    })
    await waitFor(() => {
      expect(mockSendMessage.mutateAsync).toHaveBeenCalledWith({
        sessionId: 's-1',
        agentSlug: 'agent-1',
        content: 'Hello',
      })
    })
  })

  // ---- Does not submit when isPending ----

  it('does not submit when sendMessage is pending', async () => {
    mockSendMessage.isPending = true
    const user = userEvent.setup()
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )

    const input = screen.getByTestId('message-input')
    await user.type(input, 'Hello')
    await user.keyboard('{Enter}')

    expect(mockSendMessage.mutateAsync).not.toHaveBeenCalled()
  })

  // ---- Interrupt prevents double-click ----

  it('does not double-interrupt when isPending', async () => {
    mockStreamState.isActive = true
    mockInterruptSession.isPending = true
    const user = userEvent.setup()
    renderWithProviders(
      <MessageInput sessionId="s-1" agentSlug="agent-1" />
    )

    await user.click(screen.getByTestId('stop-button'))

    // Should not call when already pending (handleInterrupt checks isPending)
    expect(mockInterruptSession.mutateAsync).not.toHaveBeenCalled()
  })
})
