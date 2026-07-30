// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FileTabBar } from './file-tab-bar'
import type { PreviewTab } from '@renderer/context/file-preview-context'

const tabs: PreviewTab[] = [
  {
    kind: 'folder',
    rootPath: '/workspace/reports',
    agentSlug: 'test-agent',
    displayName: 'reports',
    expandedPaths: ['/workspace/reports'],
    query: '',
  },
  {
    kind: 'file',
    filePath: '/workspace/reports/summary.md',
    agentSlug: 'test-agent',
    displayName: 'summary.md',
    version: 0,
    pdfPage: 1,
  },
]

describe('FileTabBar', () => {
  it('renders folder and file tabs and closes by discriminated key', async () => {
    const user = userEvent.setup()
    const onCloseTab = vi.fn()
    render(
      <FileTabBar
        tabs={tabs}
        activeIndex={0}
        onTabClick={vi.fn()}
        onCloseTab={onCloseTab}
      />,
    )

    expect(screen.getByTestId('file-tab-bar').children).toHaveLength(2)
    expect(screen.getAllByTestId('file-tab')[0]).toHaveAttribute('data-tab-kind', 'folder')
    const folderClose = screen.getAllByTestId('file-tab-close')[0]
    await user.click(folderClose)

    expect(onCloseTab).toHaveBeenCalledWith('folder:/workspace/reports')
  })
})
