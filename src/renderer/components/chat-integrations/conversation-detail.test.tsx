// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConversationDetail } from './conversation-detail'
import { makeSession } from './test-factories'
import type { ChatRow } from './chat-inbox-model'
import type { ChatIntegrationSession } from '@shared/lib/db/schema'

// Shims for Radix Select in jsdom (mirrors runtime-tab.test).
Element.prototype.scrollIntoView = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)
Element.prototype.releasePointerCapture = vi.fn()

// DialogTitle needs a Radix Dialog context; stub it so ConversationDetail renders
// standalone. SessionThread/FilePreview are stubbed like the inbox test does.
vi.mock('@renderer/components/ui/dialog', () => ({
  DialogTitle: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}))
// The stub calls the REAL useWorkflow so this test reproduces the thread's
// dependency on WorkflowContext (MessageList reads it): if ConversationDetail
// ever stops wrapping the thread in WorkflowProvider, this render throws - the
// exact crash that shipped when the rebase added useWorkflow to MessageList.
vi.mock('@renderer/components/messages/session-thread', async () => {
  const { useWorkflow } = await vi.importActual<typeof import('@renderer/context/workflow-context')>(
    '@renderer/context/workflow-context',
  )
  return {
    SessionThread: (p: any) => {
      useWorkflow()
      return <div data-testid="session-thread">{p.sessionId}</div>
    },
  }
})
vi.mock('@renderer/context/file-preview-context', () => ({
  FilePreviewProvider: ({ children }: any) => <>{children}</>,
}))

function win(sessionId: string, iso: string, cleared = false): ChatIntegrationSession {
  return makeSession({
    externalChatId: 'chat-1', sessionId,
    updatedAt: new Date(iso), archivedAt: cleared ? new Date(iso) : null,
  })
}

function makeRow(windows: ChatIntegrationSession[]): ChatRow {
  return {
    externalChatId: 'chat-1', title: 'Dana', status: 'allowed',
    windows, latestSessionId: windows[0]?.sessionId ?? null, lastActivityAt: 0,
  }
}

const props = { agentSlug: 'a', providerName: 'Telegram' }

const onSelectWindow = vi.fn<(sessionId: string) => void>()
const onNewConversation = vi.fn<(externalChatId: string) => void>()

describe('ConversationDetail window switcher', () => {
  beforeEach(() => {
    onSelectWindow.mockReset()
    onNewConversation.mockReset()
  })

  it('switches to another window by its sessionId', async () => {
    const user = userEvent.setup()
    // Two live windows -> switcher lists both, no "New conversation" option.
    const row = makeRow([win('sess-a', '2026-06-20T12:00:00Z'), win('sess-b', '2026-06-19T09:00:00Z')])
    render(
      <ConversationDetail
        row={row}
        openWindowId="sess-a"
        onSelectWindow={onSelectWindow}
        onNewConversation={onNewConversation}
        {...props}
      />,
    )

    const trigger = screen.getByRole('combobox', { name: 'Switch conversation' })
    trigger.focus()
    // Radix Select in jsdom is unreliable via click on the trigger; keyboard is deterministic.
    await user.keyboard('[Enter]')
    // Options render in row.windows order (no "New conversation" prepended here),
    // so [1] is the other window (sess-b).
    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(2)
    await user.click(options[1])

    expect(onSelectWindow).toHaveBeenCalledWith('sess-b')
    expect(onNewConversation).not.toHaveBeenCalled()
  })

  it('picks "New conversation" to start a fresh one for the chat', async () => {
    const user = userEvent.setup()
    // Every window cleared -> the switcher offers "New conversation" as the fresh option.
    const row = makeRow([win('sess-a', '2026-06-20T12:00:00Z', true), win('sess-b', '2026-06-19T09:00:00Z', true)])
    render(
      <ConversationDetail
        row={row}
        openWindowId="sess-a"
        onSelectWindow={onSelectWindow}
        onNewConversation={onNewConversation}
        {...props}
      />,
    )

    const trigger = screen.getByRole('combobox', { name: 'Switch conversation' })
    trigger.focus()
    await user.keyboard('[Enter]')
    await user.click(await screen.findByRole('option', { name: 'New conversation' }))

    expect(onNewConversation).toHaveBeenCalledWith('chat-1')
    expect(onSelectWindow).not.toHaveBeenCalled()
  })
})
