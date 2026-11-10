// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { VolumeFileBrowser } from './volume-file-browser'

const { fetchVolumeFolder } = vi.hoisted(() => ({ fetchVolumeFolder: vi.fn(async () => ({ entries: [] })) }))
vi.mock('@renderer/hooks/use-folder-entries', () => ({ fetchVolumeFolder }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('VolumeFileBrowser', () => {
  it('lists nothing from a drive still making its first copy, and says so', () => {
    render(<QueryClientProvider client={new QueryClient()}><VolumeFileBrowser volumeId="vol1" copying /></QueryClientProvider>)
    expect(screen.getByText('Copying the drive’s files. They show here once the copy is done.')).toBeInTheDocument()
    expect(screen.queryByText('Retry')).toBeNull()
    expect(fetchVolumeFolder).not.toHaveBeenCalled()
  })

  it('lists the drive once it is not copying', async () => {
    render(<QueryClientProvider client={new QueryClient()}><VolumeFileBrowser volumeId="vol1" /></QueryClientProvider>)
    await waitFor(() => expect(fetchVolumeFolder).toHaveBeenCalledWith('vol1', ''))
    expect(screen.queryByText('Copying the drive’s files. They show here once the copy is done.')).toBeNull()
  })
})
