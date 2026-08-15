// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup, fireEvent } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { createAssistantMessage } from '@renderer/test/factories'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { MessageItem } from './message-item'
import { TranscriptText } from './agent-transcript'
import { WorkflowResultCard } from './workflow-result-card'

vi.mock('./subagent-block', () => ({
  SubAgentBlock: ({ toolCall }: { toolCall: { name: string } }) => (
    <div data-testid="subagent-block">{toolCall.name}</div>
  ),
}))

vi.mock('./tool-call-item', () => ({
  ToolCallItem: ({ toolCall }: { toolCall: { name: string } }) => (
    <div data-testid={`tool-call-${toolCall.name}`}>{toolCall.name}</div>
  ),
  StreamingToolCallItem: ({ name }: { name: string }) => (
    <div data-testid="streaming-tool-call">{name}</div>
  ),
}))

vi.mock('./message-context-menu', () => ({
  MessageContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

vi.mock('./insufficient-balance-card', () => ({
  usePlatformBillingUrl: () => null,
  InsufficientBalanceCard: () => <div data-testid="insufficient-balance-card" />,
}))

function PreviewProbe() {
  const { isOpen, openTabs } = useFilePreview()
  const active = openTabs[0]
  return (
    <div data-testid="preview-probe">
      {isOpen && active?.kind === 'file' ? `${active.filePath}|${active.agentSlug}` : 'closed'}
    </div>
  )
}

function renderChat(text: string, { streaming = false, agentSlug = 'agent-1' }: { streaming?: boolean; agentSlug?: string } = {}) {
  return renderWithProviders(
    <>
      <PreviewProbe />
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

    expect(screen.getByTestId('preview-probe').textContent).toBe(
      '/workspace/output/report.md|agent-1',
    )
  })

  it('opens a /workspace/ link from the still-streaming tail', () => {
    renderChat('See [the report](/workspace/output/report.md)', { streaming: true })

    fireEvent.click(screen.getByRole('button', { name: 'the report' }))

    expect(screen.getByTestId('preview-probe').textContent).toBe(
      '/workspace/output/report.md|agent-1',
    )
  })

  it('decodes a percent-encoded filename before opening', () => {
    renderChat('See [the report](/workspace/my%20report.md)')

    fireEvent.click(screen.getByText('the report'))

    expect(screen.getByTestId('preview-probe').textContent).toBe(
      '/workspace/my report.md|agent-1',
    )
  })

  it('does not open https links in the preview tray', () => {
    renderChat('See [the site](https://example.com/x.md)')

    const link = screen.getByText('the site')
    expect(link.getAttribute('href')).toBe('https://example.com/x.md')
    fireEvent.click(link)

    expect(screen.getByTestId('preview-probe').textContent).toBe('closed')
  })

  it('leaves workspace links as normal links when the agent is unknown', () => {
    renderWithProviders(
      <>
        <PreviewProbe />
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

    expect(screen.getByTestId('preview-probe').textContent).toBe('closed')
  })

  it('opens a /workspace/ link from a subagent transcript', () => {
    renderWithProviders(
      <>
        <PreviewProbe />
        <TranscriptText agentSlug="agent-1">See [the report](/workspace/output/report.md)</TranscriptText>
      </>,
    )

    fireEvent.click(screen.getByText('the report'))

    expect(screen.getByTestId('preview-probe').textContent).toBe(
      '/workspace/output/report.md|agent-1',
    )
  })

  it('opens a /workspace/ link from a workflow result card', () => {
    renderWithProviders(
      <>
        <PreviewProbe />
        <WorkflowResultCard
          agentSlug="agent-1"
          notification={{ result: 'See [the report](/workspace/output/report.md)' }}
        />
      </>,
    )

    fireEvent.click(screen.getByText('the report'))

    expect(screen.getByTestId('preview-probe').textContent).toBe(
      '/workspace/output/report.md|agent-1',
    )
  })
})
