// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RequestLogsTable } from './request-logs-table'
import type { RequestLogEntry } from '@shared/lib/types/request-log'

const entry: RequestLogEntry = {
  id: 'request-1',
  source: 'proxy',
  agentSlug: 'agent-1',
  label: 'github',
  targetUrl: '/repos/openai/codex',
  method: 'GET',
  statusCode: 200,
  errorMessage: null,
  durationMs: 35,
  policyDecision: 'allow',
  matchedScopes: '["repo.read"]',
  createdAt: '2026-07-20T12:00:00.000Z',
}

describe('RequestLogsTable', () => {
  it('uses the connection column set and paginates', async () => {
    const onPageChange = vi.fn()
    render(
      <RequestLogsTable
        entries={[entry]}
        total={16}
        page={0}
        onPageChange={onPageChange}
        isLoading={false}
        columns={{ agent: true }}
        agentLabel={() => 'Research Agent'}
      />,
    )

    expect(screen.getByRole('columnheader', { name: 'Agent' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Source' })).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Toolkit' })).not.toBeInTheDocument()
    expect(screen.getByText('Research Agent')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(onPageChange).toHaveBeenCalledWith(1)
  })

  it('expands a row with request details', async () => {
    render(
      <RequestLogsTable
        entries={[entry]}
        total={1}
        page={0}
        onPageChange={vi.fn()}
        isLoading={false}
        columns={{ source: true, toolkit: true }}
      />,
    )

    await userEvent.click(screen.getByText('/repos/openai/codex'))

    expect(screen.getByText('Full path')).toBeInTheDocument()
    expect(screen.getByText('API Proxy')).toBeInTheDocument()
    expect(screen.getByText('repo.read')).toBeInTheDocument()
  })
})
