// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { mockOpen, mockComplete, mockFile, importProps } = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockComplete: vi.fn(async () => {}),
  mockFile: vi.fn(async () => {}),
  importProps: { current: null as null | { open: boolean; onComplete: (agent: { slug: string }) => Promise<void> } },
}))

vi.mock('@renderer/hooks/use-open-create-agent', () => ({ useOpenCreateAgent: () => mockOpen }))
vi.mock('@renderer/hooks/use-complete-template-install', () => ({ useCompleteTemplateInstall: () => mockComplete }))
vi.mock('@renderer/hooks/use-file-agent-into-section', () => ({ useFileAgentIntoSection: () => mockFile }))
vi.mock('@renderer/components/agents/import-agent-dialog', () => ({
  ImportAgentDialog: (props: NonNullable<typeof importProps.current>) => {
    importProps.current = props
    return props.open ? <div data-testid="import-dialog" /> : null
  },
}))

import { NewAgentMenu } from './new-agent-menu'

async function openMenu(onChoose?: () => void, folderId?: string) {
  render(
    <NewAgentMenu surface="section_plus" folderId={folderId} onChoose={onChoose}>
      <button type="button">New Agent</button>
    </NewAgentMenu>,
  )
  screen.getByRole('button', { name: 'New Agent' }).focus()
  await userEvent.keyboard('{ArrowDown}')
}

beforeEach(() => {
  vi.clearAllMocks()
  importProps.current = null
})

describe('NewAgentMenu', () => {
  it('offers the three ways to make an agent', async () => {
    await openMenu()
    expect(screen.getByRole('menuitem', { name: 'From Scratch' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Browse Templates' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Import' })).toBeInTheDocument()
  })

  it('From Scratch opens the create page for its section', async () => {
    const onChoose = vi.fn()
    await openMenu(onChoose, 'f1')
    await userEvent.click(screen.getByRole('menuitem', { name: 'From Scratch' }))
    expect(onChoose).toHaveBeenCalled()
    expect(mockOpen).toHaveBeenCalledWith({ surface: 'section_plus', folderId: 'f1' })
  })

  it('Browse Templates opens the template page', async () => {
    await openMenu(undefined, 'f1')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Browse Templates' }))
    expect(mockOpen).toHaveBeenCalledWith({ surface: 'section_plus', folderId: 'f1', start: 'templates' })
  })

  it('Import opens the dialog in place and files the imported agent', async () => {
    await openMenu(undefined, 'f1')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Import' }))
    expect(screen.getByTestId('import-dialog')).toBeInTheDocument()
    expect(mockOpen).not.toHaveBeenCalled()

    await importProps.current?.onComplete({ slug: 'imported' })
    expect(mockComplete).toHaveBeenCalledWith({ slug: 'imported' }, { source: 'import', surface: 'section_plus' })
    expect(mockFile).toHaveBeenCalledWith('imported', 'f1')
  })
})
