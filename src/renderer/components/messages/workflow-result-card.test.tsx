// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowResultCard } from './workflow-result-card'

vi.mock('@renderer/context/workflow-context', () => ({ useWorkflow: () => ({ openWorkflow: vi.fn() }) }))

describe('WorkflowResultCard', () => {
  it('draws a mermaid fence in the workflow result and keeps other fences as code', async () => {
    const { container } = render(<WorkflowResultCard notification={{ result: 'Plan:\n\n```mermaid\ngraph LR\n  Scan --> Fix\n```\n\n```ts\nconst done = true\n```' }} />)

    expect(await screen.findByTestId('mermaid-diagram')).toBeInTheDocument()
    expect(screen.getByText('Plan:')).toBeInTheDocument()
    expect(container.querySelector('pre')).toHaveTextContent('const done = true')
  })
})
