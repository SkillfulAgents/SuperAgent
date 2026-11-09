// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { mockPush, mockComplete, mockFile, search, installProps } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockComplete: vi.fn(async () => {}),
  mockFile: vi.fn(async () => {}),
  search: {} as { from?: string; section?: string; surface?: string },
  installProps: { current: null as null | { template: unknown; onInstalled: (agent: { slug: string }) => Promise<void> } },
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: mockPush } }),
  useSearch: () => search,
}))
vi.mock('@renderer/hooks/use-complete-template-install', () => ({ useCompleteTemplateInstall: () => mockComplete }))
vi.mock('@renderer/hooks/use-file-agent-into-section', () => ({ useFileAgentIntoSection: () => mockFile }))
vi.mock('@renderer/components/agents/create-agent-templates', () => ({
  CreateAgentTemplates: ({ onSelect, standalone }: { onSelect: (t: unknown) => void; standalone?: boolean }) => (
    <button type="button" data-standalone={String(standalone)} onClick={() => onSelect({ path: 'sales' })}>Sales template</button>
  ),
}))
vi.mock('@renderer/components/agents/template-install-dialog', () => ({
  TemplateInstallDialog: (props: NonNullable<typeof installProps.current>) => {
    installProps.current = props
    return props.template ? <div data-testid="install-dialog" /> : null
  },
}))
vi.mock('@renderer/components/agents/import-agent-dialog', () => ({ ImportAgentDialog: () => null }))

import { NewAgentTemplatesPage } from './new-agent-templates-page'

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(search)) delete search[key as keyof typeof search]
})

describe('NewAgentTemplatesPage', () => {
  it('shows the roster as the page subject', () => {
    render(<NewAgentTemplatesPage />)
    expect(screen.getByRole('button', { name: 'Sales template' })).toHaveAttribute('data-standalone', 'true')
  })

  it('installs a picked template and files it into the section it was opened from', async () => {
    Object.assign(search, { section: 'f1', surface: 'nav' })
    render(<NewAgentTemplatesPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Sales template' }))
    expect(screen.getByTestId('install-dialog')).toBeInTheDocument()

    await installProps.current?.onInstalled({ slug: 'sales-1' })
    expect(mockComplete).toHaveBeenCalledWith({ slug: 'sales-1' }, { source: 'skillset', surface: 'nav' })
    expect(mockFile).toHaveBeenCalledWith('sales-1', 'f1')
  })

  it('leaves with Back or the X', async () => {
    search.from = '/agents/alpha'
    render(<NewAgentTemplatesPage />)
    await userEvent.click(screen.getByTestId('new-agent-back'))
    await userEvent.click(screen.getByTestId('create-agent-close'))
    expect(mockPush).toHaveBeenNthCalledWith(1, '/agents/alpha')
    expect(mockPush).toHaveBeenNthCalledWith(2, '/agents/alpha')
  })
})
