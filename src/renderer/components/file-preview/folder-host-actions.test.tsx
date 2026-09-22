// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { _resetApiTargetForTest, setActiveTarget } from '@renderer/lib/api-target'
import { FolderHostActions } from './folder-host-actions'
import type { FolderTab } from '@renderer/context/file-preview-context'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  revealInFolder: vi.fn().mockResolvedValue(null),
  canManage: true,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ canAdminAgent: () => mocks.canManage }),
}))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))

const FOLDER: FolderTab = {
  kind: 'folder',
  rootPath: '/workspace',
  agentSlug: 'test-agent',
  displayName: 'workspace',
  expandedPaths: ['/workspace'],
  query: '',
}

function hostPathResponse(hostPath: string) {
  return new Response(JSON.stringify({ hostPath }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('FolderHostActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.canManage = true
    delete window.electronAPI
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('copies the folder host path resolved by the API', async () => {
    mocks.apiFetch.mockResolvedValue(hostPathResponse('/srv/agents/test-agent/workspace'))
    render(<FolderHostActions folder={FOLDER} />)

    await userEvent.click(screen.getByTestId('folder-copy-path'))

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/srv/agents/test-agent/workspace'))
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/agents/test-agent/folders/reveal-path',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ root: '/workspace', path: '/workspace' }),
      }),
    )
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Folder path copied')
  })

  it('toasts instead of copying when the path cannot be resolved', async () => {
    mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Folder bookmark not found' }), { status: 404 }))
    render(<FolderHostActions folder={FOLDER} />)

    await userEvent.click(screen.getByTestId('folder-copy-path'))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      'Could not copy folder path',
      { description: 'Folder bookmark not found' },
    ))
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('reveals the folder through Electron, labelled for the platform', async () => {
    window.electronAPI = {
      platform: 'darwin',
      revealInFolder: mocks.revealInFolder,
    } as unknown as typeof window.electronAPI
    mocks.apiFetch.mockResolvedValue(hostPathResponse('/srv/agents/test-agent/workspace'))
    render(<FolderHostActions folder={FOLDER} />)

    await userEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))

    await waitFor(() => expect(mocks.revealInFolder).toHaveBeenCalledWith('/srv/agents/test-agent/workspace'))
  })

  it('offers no reveal outside Electron, only the copy', () => {
    render(<FolderHostActions folder={FOLDER} />)

    expect(screen.getByTestId('folder-copy-path')).toBeInTheDocument()
    expect(screen.queryByTestId('folder-reveal')).not.toBeInTheDocument()
  })

  it('withdraws reveal against a cloud workspace but keeps copy', () => {
    // The host path comes back from the deployment and describes ITS
    // filesystem: fine to paste as text, wrong to open here.
    window.electronAPI = {
      platform: 'darwin',
      revealInFolder: mocks.revealInFolder,
    } as unknown as typeof window.electronAPI
    _resetApiTargetForTest() // the global setup already settled it to 'local'
    setActiveTarget('cloud', null)
    try {
      render(<FolderHostActions folder={FOLDER} />)

      expect(screen.getByTestId('folder-copy-path')).toBeInTheDocument()
      expect(screen.queryByTestId('folder-reveal')).not.toBeInTheDocument()
    } finally {
      _resetApiTargetForTest()
      setActiveTarget('local', null)
    }
  })

  it('renders nothing for a user who cannot administer the agent', () => {
    // The reveal-path endpoint is owner-only; don't offer a button that 403s.
    mocks.canManage = false
    render(<FolderHostActions folder={FOLDER} />)

    expect(screen.queryByTestId('folder-copy-path')).not.toBeInTheDocument()
  })
})
