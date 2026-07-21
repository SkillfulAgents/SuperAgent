// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeBookmarks } from './home-bookmarks'

const openFile = vi.fn()

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ openFile }),
}))

vi.mock('@renderer/hooks/use-bookmarks', () => ({
  useBookmarks: () => ({
    data: [
      { name: 'Daily report', file: '/workspace/reports/daily.csv' },
      { name: 'Project site', link: 'https://example.com/project' },
    ],
  }),
  useUpdateBookmarks: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}))

describe('HomeBookmarks', () => {
  beforeEach(() => {
    openFile.mockReset()
  })

  it('opens workspace files in the file preview context', async () => {
    const user = userEvent.setup()
    render(<HomeBookmarks agentSlug="test-agent" />)

    await user.click(screen.getByRole('button', { name: 'Daily report' }))

    expect(openFile).toHaveBeenCalledWith('/workspace/reports/daily.csv', 'test-agent')
  })

  it('keeps web bookmarks as external links', () => {
    render(<HomeBookmarks agentSlug="test-agent" />)

    expect(screen.getByRole('link', { name: 'Project site' })).toHaveAttribute(
      'href',
      'https://example.com/project',
    )
  })
})
