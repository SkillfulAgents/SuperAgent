// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FolderEntryContextMenu } from './folder-file-context-menu'
import type { FolderTab } from '@renderer/context/file-preview-context'
import type { FolderEntry } from '@renderer/hooks/use-folder-entries'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  downloadBlob: vi.fn(),
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  renameFilePath: vi.fn(),
  removeFilePath: vi.fn(),
  renameDirectoryPath: vi.fn(),
  removeDirectoryPath: vi.fn(),
  updateBookmarks: vi.fn().mockResolvedValue([]),
  bookmarks: [] as Array<{ name: string; file?: string; folder?: string }>,
  revealInFolder: vi.fn().mockResolvedValue(null),
  canManage: true,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}))

vi.mock('@renderer/lib/download', () => ({
  downloadBlob: (...args: unknown[]) => mocks.downloadBlob(...args),
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}))

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({
    renameFilePath: mocks.renameFilePath,
    removeFilePath: mocks.removeFilePath,
    renameDirectoryPath: mocks.renameDirectoryPath,
    removeDirectoryPath: mocks.removeDirectoryPath,
  }),
}))

vi.mock('@renderer/hooks/use-bookmarks', () => ({
  useBookmarks: () => ({ data: mocks.bookmarks, isLoading: false }),
  useUpdateBookmarks: () => ({ mutateAsync: mocks.updateBookmarks, isPending: false }),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ canAdminAgent: () => mocks.canManage }),
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))

vi.mock('@renderer/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>{children}</button>
  ),
  ContextMenuSeparator: () => <hr />,
}))

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('@renderer/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <>{children}</> : null,
  AlertDialogAction: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>{children}</button>
  ),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

const folder: FolderTab = {
  kind: 'folder',
  rootPath: '/workspace/reports',
  agentSlug: 'test-agent',
  displayName: 'reports',
  expandedPaths: ['/workspace/reports'],
  query: '',
}

function renderMenu(file: FolderEntry = {
  name: 'notes.md',
  path: '/workspace/reports/notes.md',
  type: 'file',
}) {
  return render(
    <FolderEntryContextMenu
      folder={folder}
      entry={file}
      bookmarks={mocks.bookmarks}
      bookmarksLoading={false}
      updateBookmarks={{ mutateAsync: mocks.updateBookmarks, isPending: false }}
    >
      <button type="button">notes.md</button>
    </FolderEntryContextMenu>,
  )
}

describe('FolderFileContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.canManage = true
    mocks.bookmarks = []
    delete window.electronAPI
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('shows copy for text files and owner-only file actions', () => {
    renderMenu()

    expect(screen.getByRole('button', { name: 'Copy contents' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Download' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Bookmark' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Rename' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeVisible()
  })

  it('does not offer copy contents for binary files', () => {
    renderMenu({ name: 'photo.png', path: '/workspace/reports/photo.png', type: 'file' })

    expect(screen.queryByRole('button', { name: 'Copy contents' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download' })).toBeVisible()
  })

  it('keeps mutations hidden for users without agent admin access', () => {
    mocks.canManage = false
    renderMenu()

    expect(screen.getByRole('button', { name: 'Copy contents' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Download' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Bookmark' })).not.toBeInTheDocument()
  })

  it('offers directory actions without file-only copy and download actions', () => {
    renderMenu({ name: 'drafts', path: '/workspace/reports/drafts', type: 'directory' })

    expect(screen.queryByRole('button', { name: 'Copy contents' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bookmark' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Rename' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeVisible()
  })

  it('bookmarks files and directories with their workspace paths', async () => {
    const user = userEvent.setup()
    const { unmount } = renderMenu()
    await user.click(screen.getByRole('button', { name: 'Bookmark' }))

    await waitFor(() => expect(mocks.updateBookmarks).toHaveBeenCalledWith([
      { name: 'notes.md', file: '/workspace/reports/notes.md' },
    ]))

    unmount()
    mocks.updateBookmarks.mockClear()
    renderMenu({ name: 'drafts', path: '/workspace/reports/drafts', type: 'directory' })
    await user.click(screen.getByRole('button', { name: 'Bookmark' }))

    await waitFor(() => expect(mocks.updateBookmarks).toHaveBeenCalledWith([
      { name: 'drafts', folder: '/workspace/reports/drafts' },
    ]))
  })

  it('removes an existing bookmark', async () => {
    const user = userEvent.setup()
    mocks.bookmarks = [
      { name: 'Notes', file: '/workspace/reports/notes.md' },
      { name: 'Other', file: '/workspace/reports/other.md' },
    ]
    renderMenu()

    await user.click(screen.getByRole('button', { name: 'Remove bookmark' }))

    await waitFor(() => expect(mocks.updateBookmarks).toHaveBeenCalledWith([
      { name: 'Other', file: '/workspace/reports/other.md' },
    ]))
  })

  it('copies fetched text contents to the clipboard', async () => {
    mocks.apiFetch.mockResolvedValue(new Response('hello world'))
    renderMenu()

    fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello world'))
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/agents/test-agent/files/reports/notes.md?inline=true',
    )
  })

  it('downloads through the authenticated file route', async () => {
    const user = userEvent.setup()
    const response = new Response('file contents')
    mocks.apiFetch.mockResolvedValue(response)
    renderMenu()

    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(mocks.downloadBlob).toHaveBeenCalledWith(response, 'notes.md'))
  })

  it('renames the file and refreshes the folder tree', async () => {
    const user = userEvent.setup()
    mocks.apiFetch.mockResolvedValue(new Response(
      JSON.stringify({ path: '/workspace/reports/renamed.md', name: 'renamed.md' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    renderMenu()

    await user.click(screen.getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'File name' }), {
      target: { value: 'renamed.md' },
    })
    await user.click(screen.getAllByRole('button', { name: 'Rename' }).at(-1)!)

    await waitFor(() => expect(mocks.renameFilePath).toHaveBeenCalledWith(
      '/workspace/reports/notes.md',
      '/workspace/reports/renamed.md',
    ))
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['folder-entries', 'test-agent', '/workspace/reports'],
    })
  })

  it('requires confirmation before deleting the file', async () => {
    const user = userEvent.setup()
    mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    renderMenu()

    await user.click(screen.getByTestId('folder-file-delete'))
    expect(screen.getByRole('heading', { name: 'Delete File' })).toBeVisible()
    await user.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!)

    await waitFor(() => expect(mocks.removeFilePath).toHaveBeenCalledWith(
      '/workspace/reports/notes.md',
    ))
  })

  it('renames and deletes directories through directory-safe mutations', async () => {
    const user = userEvent.setup()
    mocks.apiFetch
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ path: '/workspace/reports/archive', name: 'archive' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    const entry = { name: 'drafts', path: '/workspace/reports/drafts', type: 'directory' as const }
    const { unmount } = renderMenu(entry)

    await user.click(screen.getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), {
      target: { value: 'archive' },
    })
    await user.click(screen.getAllByRole('button', { name: 'Rename' }).at(-1)!)
    await waitFor(() => expect(mocks.renameDirectoryPath).toHaveBeenCalledWith(
      '/workspace/reports/drafts',
      '/workspace/reports/archive',
    ))

    unmount()
    renderMenu(entry)
    await user.click(screen.getByTestId('folder-directory-delete'))
    expect(screen.getByRole('heading', { name: 'Delete Folder' })).toBeVisible()
    await user.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!)
    await waitFor(() => expect(mocks.removeDirectoryPath).toHaveBeenCalledWith(
      '/workspace/reports/drafts',
    ))
  })

  it('reveals files through Electron only', async () => {
    const user = userEvent.setup()
    window.electronAPI = {
      platform: 'darwin',
      revealInFolder: mocks.revealInFolder,
    } as unknown as typeof window.electronAPI
    mocks.apiFetch.mockResolvedValue(new Response(
      JSON.stringify({ hostPath: '/host/workspace/reports/notes.md' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    renderMenu()

    await user.click(screen.getByRole('button', { name: 'Reveal in Finder' }))

    await waitFor(() => expect(mocks.revealInFolder).toHaveBeenCalledWith(
      '/host/workspace/reports/notes.md',
    ))
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/agents/test-agent/folders/reveal-path',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
