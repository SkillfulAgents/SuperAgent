// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { CopyFileButton } from './copy-file-button'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const FILE_URL = 'http://localhost/api/agents/a/files/notes.md?inline=true'

let queryClient: QueryClient
let writeText: ReturnType<typeof vi.fn>

function renderButton() {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopyFileButton fileUrl={FILE_URL} displayName="notes.md" />
    </QueryClientProvider>,
  )
}

function clickCopy() {
  fireEvent.click(screen.getByRole('button', { name: 'Copy file contents' }))
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('CopyFileButton', () => {
  it('copies the text the renderer already loaded without refetching', async () => {
    queryClient.setQueryData(['file-content', FILE_URL], { text: '# Notes', truncated: false })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    renderButton()

    clickCopy()

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Notes'))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('Copied contents of “notes.md”')
  })

  it('shows a check mark for a few seconds, then goes back to the copy icon', async () => {
    vi.useFakeTimers()
    queryClient.setQueryData(['file-content', FILE_URL], { text: '# Notes', truncated: false })
    renderButton()

    expect(screen.getByTestId('file-preview-copy-icon')).toBeInTheDocument()

    clickCopy()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByTestId('file-preview-copied-icon')).toBeInTheDocument()

    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(screen.getByTestId('file-preview-copy-icon')).toBeInTheDocument()
  })

  it('fetches the file when the renderer has not cached it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('plain body', { status: 200 })))
    renderButton()

    clickCopy()

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('plain body'))
  })

  it('refuses to put binary content on the clipboard', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('PNG\u0000data', { status: 200 })))
    renderButton()

    clickCopy()

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not copy file contents', {
      description: '“notes.md” is not a text file',
    }))
    expect(writeText).not.toHaveBeenCalled()
  })

  it('reports a failed load instead of silently confirming', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })))
    renderButton()

    clickCopy()

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.queryByTestId('file-preview-copied-icon')).not.toBeInTheDocument()
  })

  it('says so when the preview only holds part of a huge file', async () => {
    queryClient.setQueryData(['file-content', FILE_URL], { text: 'partial', truncated: true })
    renderButton()

    clickCopy()

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      'Copied the first 5,000,000 characters of “notes.md”',
    ))
  })
})
