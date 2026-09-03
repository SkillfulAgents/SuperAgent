// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen, cleanup, fireEvent } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { createAssistantMessage } from '@renderer/test/factories'
import { MessageItem } from './message-item'
import { TranscriptText } from './agent-transcript'
import { WorkflowResultCard } from './workflow-result-card'
import { FilePreviewProbe } from '@renderer/test/file-preview-probe'

vi.mock('./subagent-block', async () => (await import('@renderer/test/message-item-test-mocks')).subagentBlock)
vi.mock('./tool-call-item', async () => (await import('@renderer/test/message-item-test-mocks')).toolCallItem)
vi.mock('./message-context-menu', async () => (await import('@renderer/test/message-item-test-mocks')).messageContextMenu)
vi.mock('@renderer/components/ui/tooltip', async () => (await import('@renderer/test/message-item-test-mocks')).tooltip)

function renderChat(text: string, { streaming = false, agentSlug = 'agent-1' }: { streaming?: boolean; agentSlug?: string } = {}) {
  return renderWithProviders(
    <>
      <FilePreviewProbe />
      <MessageItem
        message={createAssistantMessage({ content: { text } })}
        agentSlug={agentSlug}
        isStreaming={streaming}
      />
    </>,
  )
}

describe('chat workspace file links', () => {
  afterEach(cleanup)

  it('opens a /workspace/ link in the preview tray from a persisted message', () => {
    renderChat('See [the report](/workspace/output/report.md)')

    const link = screen.getByRole('button', { name: 'the report' })
    fireEvent.click(link)

    expect(screen.getByTestId('file-preview-probe').textContent).toBe(
      '/workspace/output/report.md|agent-1',
    )
  })

  it('opens a /workspace/ link from the still-streaming tail', () => {
    renderChat('See [the report](/workspace/output/report.md)', { streaming: true })

    fireEvent.click(screen.getByRole('button', { name: 'the report' }))

    expect(screen.getByTestId('file-preview-probe').textContent).toBe(
      '/workspace/output/report.md|agent-1',
    )
  })

  it('decodes a percent-encoded filename before opening', () => {
    renderChat('See [the report](/workspace/my%20report.md)')

    fireEvent.click(screen.getByText('the report'))

    expect(screen.getByTestId('file-preview-probe').textContent).toBe(
      '/workspace/my report.md|agent-1',
    )
  })

  it('does not open https links in the preview tray', () => {
    renderChat('See [the site](https://example.com/x.md)')

    const link = screen.getByText('the site')
    expect(link.getAttribute('href')).toBe('https://example.com/x.md')
    fireEvent.click(link)

    expect(screen.getByTestId('file-preview-probe').textContent).toBe('closed')
  })

  it('leaves workspace links as normal links when the agent is unknown', () => {
    renderWithProviders(
      <>
        <FilePreviewProbe />
        <MessageItem
          message={createAssistantMessage({
            content: { text: 'See [the report](/workspace/output/report.md)' },
          })}
        />
      </>,
    )

    const link = screen.getByText('the report')
    expect(link.getAttribute('href')).toBe('/workspace/output/report.md')
    fireEvent.click(link)

    expect(screen.getByTestId('file-preview-probe').textContent).toBe('closed')
  })

  it('opens a /workspace/ link from a subagent transcript', () => {
    renderWithProviders(
      <>
        <FilePreviewProbe />
        <TranscriptText agentSlug="agent-1">See [the report](/workspace/output/report.md)</TranscriptText>
      </>,
    )

    fireEvent.click(screen.getByText('the report'))

    expect(screen.getByTestId('file-preview-probe').textContent).toBe(
      '/workspace/output/report.md|agent-1',
    )
  })

  it('opens a /workspace/ link from a workflow result card', () => {
    renderWithProviders(
      <>
        <FilePreviewProbe />
        <WorkflowResultCard
          agentSlug="agent-1"
          notification={{ result: 'See [the report](/workspace/output/report.md)' }}
        />
      </>,
    )

    fireEvent.click(screen.getByText('the report'))

    expect(screen.getByTestId('file-preview-probe').textContent).toBe(
      '/workspace/output/report.md|agent-1',
    )
  })

  it('shows a workflow result card when the assistant text is only a notification', () => {
    renderWithProviders(
      <MessageItem
        message={createAssistantMessage({
          content: {
            text: '<task-notification>{"result":"Audit done","title":"Audit"}</task-notification>',
          },
        })}
        agentSlug="agent-1"
      />,
    )

    expect(screen.getByText('Workflow completed')).toBeInTheDocument()
    expect(screen.getByText('Audit done')).toBeInTheDocument()
    expect(screen.getByText('Audit')).toBeInTheDocument()
  })
})
