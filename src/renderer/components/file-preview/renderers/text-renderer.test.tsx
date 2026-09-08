// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TextRenderer } from './text-renderer'

vi.mock('./use-file-content', () => ({
  useFileContent: () => ({
    data: { text: 'first line\nsecond line', truncated: false },
    isLoading: false,
    error: null,
  }),
}))

vi.mock('../comments/use-text-selection', () => ({
  useTextSelection: () => ({ selection: null, clearSelection: vi.fn() }),
}))

describe('TextRenderer', () => {
  it('makes file contents selectable without including line numbers', () => {
    render(<TextRenderer url="/file.txt" filePath="/file.txt" agentSlug="test-agent" />)

    expect(screen.getByText('first line')).toHaveClass('select-text')
    expect(screen.getByText('1')).toHaveClass('select-none')
  })
})
