// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@renderer/test/test-utils'
import { FilePreviewProbe } from '@renderer/test/file-preview-probe'
import { useWorkflow } from '@renderer/context/workflow-context'
import { WorkflowTrayContent } from './workflow-tray-content'

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ workflows: [] }),
}))

let collapsedResult = 'See [the report](/workspace/output/report.md) from this workflow agent.'

vi.mock('@renderer/hooks/use-messages', () => ({
  useWorkflowTree: () => ({
    data: {
      runId: 'wf_1',
      name: 'Smoke',
      description: null,
      phases: [],
      expectedAgents: 1,
      totals: { toolCount: 0, tokens: 0, durationMs: 0 },
      agents: [
        {
          agentId: 'wfsmoke1',
          label: 'agent 1',
          phase: null,
          status: 'done',
          result: collapsedResult,
          resolved: 'ordinal-fallback',
          prompt: 'Return a workspace file link.',
          toolCount: 0,
          tokens: 0,
          durationMs: 1000,
        },
      ],
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useWorkflowAgentMessages: () => ({ data: [] }),
}))

function OpenTray({ expand = false }: { expand?: boolean }) {
  const { openWorkflow, setExpandedAgent, selectedRunId } = useWorkflow()
  return (
    <>
      <button
        type="button"
        onClick={() => {
          openWorkflow('wf_1', 'Smoke')
          if (expand) setExpandedAgent('wfsmoke1')
        }}
      >
        open tray
      </button>
      {selectedRunId && (
        <WorkflowTrayContent agentSlug="agent-1" sessionId="s1" onClose={() => {}} />
      )}
    </>
  )
}

describe('WorkflowTrayContent result links', () => {
  afterEach(() => {
    collapsedResult = 'See [the report](/workspace/output/report.md) from this workflow agent.'
    cleanup()
  })

  it('opens a /workspace/ link from the collapsed agent row in the preview tray', () => {
    renderWithProviders(
      <>
        <FilePreviewProbe />
        <OpenTray />
      </>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'open tray' }))
    fireEvent.click(screen.getByRole('button', { name: 'the report' }))

    expect(screen.getByTestId('file-preview-probe').textContent).toBe(
      '/workspace/output/report.md|agent-1',
    )
  })

  it('opens a /workspace/ link from the expanded Result line in the preview tray', () => {
    renderWithProviders(
      <>
        <FilePreviewProbe />
        <OpenTray expand />
      </>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'open tray' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'the report' })[1])

    expect(screen.getByTestId('file-preview-probe').textContent).toBe(
      '/workspace/output/report.md|agent-1',
    )
  })

  it('keeps a list result on one line and still opens the file link', () => {
    collapsedResult = `## Findings

- See [the report](/workspace/output/report.md)
- Then the notes`

    renderWithProviders(
      <>
        <FilePreviewProbe />
        <OpenTray />
      </>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'open tray' }))

    expect(screen.queryByRole('heading')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'the report' }))
    expect(screen.getByTestId('file-preview-probe').textContent).toBe(
      '/workspace/output/report.md|agent-1',
    )
  })
})
