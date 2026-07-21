// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FolderBrowser } from './folder-browser'
import type { FolderTab } from '@renderer/context/file-preview-context'

const mocks = vi.hoisted(() => ({
  openFile: vi.fn(),
  toggleFolder: vi.fn(),
  setFolderQuery: vi.fn(),
  selectFolderEntry: vi.fn(),
  useBookmarks: vi.fn((_agentSlug: string) => ({ data: [], isLoading: false })),
  useUpdateBookmarks: vi.fn((_agentSlug: string) => ({ mutateAsync: vi.fn(), isPending: false })),
}))

vi.mock('@renderer/context/file-preview-context', async importOriginal => {
  const actual = await importOriginal<typeof import('@renderer/context/file-preview-context')>()
  return {
    ...actual,
    useFilePreview: () => mocks,
  }
})

vi.mock('@renderer/hooks/use-folder-entries', () => ({
  FolderEntriesError: class FolderEntriesError extends Error {},
  useFolderEntries: (_agentSlug: string, _rootPath: string, folderPath: string) => ({
    data: folderPath === '/workspace/reports'
      ? {
          root: '/workspace/reports',
          path: folderPath,
          truncated: false,
          entries: [
            { name: '2026', path: '/workspace/reports/2026', type: 'directory' },
            { name: 'overview.md', path: '/workspace/reports/overview.md', type: 'file' },
            { name: 'raw.csv', path: '/workspace/reports/raw.csv', type: 'file' },
          ],
        }
      : {
          root: '/workspace/reports',
          path: folderPath,
          truncated: false,
          entries: [{ name: 'july.md', path: '/workspace/reports/2026/july.md', type: 'file' }],
        },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

vi.mock('@renderer/hooks/use-bookmarks', () => ({
  useBookmarks: (agentSlug: string) => mocks.useBookmarks(agentSlug),
  useUpdateBookmarks: (agentSlug: string) => mocks.useUpdateBookmarks(agentSlug),
}))

vi.mock('./folder-file-context-menu', () => ({
  FolderEntryContextMenu: ({ children }: { children: React.ReactNode }) => children,
}))

const baseFolder: FolderTab = {
  kind: 'folder',
  rootPath: '/workspace/reports',
  agentSlug: 'test-agent',
  displayName: 'reports',
  expandedPaths: ['/workspace/reports'],
  query: '',
}

describe('FolderBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the lazy tree and expands a directory in place', async () => {
    const user = userEvent.setup()
    render(<FolderBrowser folder={baseFolder} />)

    expect(screen.getByRole('button', { name: '2026' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'overview.md' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '2026' }))

    expect(mocks.toggleFolder).toHaveBeenCalledWith('/workspace/reports', '/workspace/reports/2026')
  })

  it('renders expanded descendants and opens a file in a separate preview tab', async () => {
    const user = userEvent.setup()
    render(
      <FolderBrowser
        folder={{ ...baseFolder, expandedPaths: [...baseFolder.expandedPaths, '/workspace/reports/2026'] }}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'july.md' }))

    expect(mocks.selectFolderEntry).toHaveBeenCalledWith(
      '/workspace/reports',
      '/workspace/reports/2026/july.md',
    )
    expect(mocks.openFile).toHaveBeenCalledWith('/workspace/reports/2026/july.md', 'test-agent')
  })

  it('filters files while keeping directories available for lazy traversal', () => {
    render(<FolderBrowser folder={{ ...baseFolder, query: 'overview' }} />)

    expect(screen.getByRole('button', { name: '2026' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'overview.md' })).toBeVisible()
    expect(screen.getByText('overview', { selector: 'mark' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'raw.csv' })).not.toBeInTheDocument()
  })

  it('highlights every case-insensitive substring match', () => {
    render(<FolderBrowser folder={{ ...baseFolder, query: 'E' }} />)

    const filename = screen.getByRole('button', { name: 'overview.md' })
    expect(filename.querySelectorAll('mark')).toHaveLength(2)
    expect(filename.querySelectorAll('mark')[0]).toHaveTextContent('e')
    expect(filename).toHaveAccessibleName('overview.md')
  })

  it('updates the persisted folder query', () => {
    render(<FolderBrowser folder={baseFolder} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Filter files' }), {
      target: { value: 'july' },
    })

    expect(mocks.setFolderQuery).toHaveBeenCalledWith('/workspace/reports', 'july')
  })

  it('creates one bookmark observer and updater for the whole tree', () => {
    render(
      <FolderBrowser
        folder={{ ...baseFolder, expandedPaths: [...baseFolder.expandedPaths, '/workspace/reports/2026'] }}
      />,
    )

    expect(screen.getAllByTestId('folder-entry')).toHaveLength(4)
    expect(mocks.useBookmarks).toHaveBeenCalledTimes(1)
    expect(mocks.useUpdateBookmarks).toHaveBeenCalledTimes(1)
    expect(mocks.useBookmarks).toHaveBeenCalledWith('test-agent')
    expect(mocks.useUpdateBookmarks).toHaveBeenCalledWith('test-agent')
  })
})
