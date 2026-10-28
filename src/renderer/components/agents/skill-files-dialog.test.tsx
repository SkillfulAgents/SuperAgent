// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SkillFilesDialog } from './skill-files-dialog'
import { renderWithProviders } from '@renderer/test/test-utils'
import { apiFetch } from '@renderer/lib/api'
import type { ApiSkillFileEntry } from '@shared/lib/types/api'

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(),
}))

vi.mock('@renderer/components/ui/code-editor', () => ({
  CodeEditor: ({ value }: { value: string }) => (
    <textarea data-testid="code-editor" value={value} readOnly />
  ),
}))

const mockApiFetch = vi.mocked(apiFetch)

// jsdom has no ResizeObserver; the file tree's Radix ScrollArea needs one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function mockSkillFiles(files: ApiSkillFileEntry[], contents: Record<string, string> = {}) {
  mockApiFetch.mockImplementation(async (path: string) => {
    const contentMatch = path.match(/\/files\/content\?path=(.+)$/)
    if (contentMatch) {
      const filePath = decodeURIComponent(contentMatch[1])
      const content = contents[filePath]
      if (content === undefined) {
        return { ok: false, status: 404, json: async () => ({}) } as Response
      }
      return { ok: true, json: async () => ({ content, path: filePath }) } as Response
    }
    if (path.endsWith('/files')) {
      return { ok: true, json: async () => ({ files }) } as Response
    }
    throw new Error(`unexpected request: ${path}`)
  })
}

function renderDialog() {
  return renderWithProviders(
    <SkillFilesDialog
      open
      onOpenChange={() => {}}
      agentSlug="agent-1"
      skillDir="my-skill"
      skillName="My Skill"
    />
  )
}

describe('SkillFilesDialog', () => {
  beforeEach(() => {
    mockApiFetch.mockReset()
  })

  it('opens SKILL.md by default', async () => {
    mockSkillFiles(
      [
        { path: 'helper.py', type: 'file' },
        { path: 'SKILL.md', type: 'file' },
      ],
      { 'SKILL.md': '# My Skill' }
    )

    renderDialog()

    await waitFor(() =>
      expect(screen.getByTestId('code-editor')).toHaveValue('# My Skill')
    )
    expect(screen.queryByText('Select a file to view')).not.toBeInTheDocument()
  })

  it('prefers the skill root SKILL.md over a nested one', async () => {
    mockSkillFiles(
      [
        { path: 'references', type: 'directory' },
        { path: 'references/SKILL.md', type: 'file' },
        { path: 'SKILL.md', type: 'file' },
      ],
      { 'SKILL.md': 'root skill', 'references/SKILL.md': 'nested skill' }
    )

    renderDialog()

    await waitFor(() =>
      expect(screen.getByTestId('code-editor')).toHaveValue('root skill')
    )
  })

  it('shows the empty state when the skill has no SKILL.md', async () => {
    mockSkillFiles([{ path: 'helper.py', type: 'file' }], { 'helper.py': 'print(1)' })

    renderDialog()

    await waitFor(() => expect(screen.getByText('helper.py')).toBeInTheDocument())
    expect(screen.getByText('Select a file to view')).toBeInTheDocument()
    expect(screen.queryByTestId('code-editor')).not.toBeInTheDocument()
    expect(
      mockApiFetch.mock.calls.some(([path]) => path.includes('/files/content'))
    ).toBe(false)
  })

  it('keeps a file the user picked instead of reverting to SKILL.md', async () => {
    mockSkillFiles(
      [
        { path: 'SKILL.md', type: 'file' },
        { path: 'helper.py', type: 'file' },
      ],
      { 'SKILL.md': '# My Skill', 'helper.py': 'print(1)' }
    )

    const user = userEvent.setup()
    renderDialog()

    await waitFor(() =>
      expect(screen.getByTestId('code-editor')).toHaveValue('# My Skill')
    )

    await user.click(screen.getByRole('button', { name: 'helper.py' }))

    await waitFor(() =>
      expect(screen.getByTestId('code-editor')).toHaveValue('print(1)')
    )
    expect(screen.getByTestId('code-editor')).toHaveValue('print(1)')
  })
})
