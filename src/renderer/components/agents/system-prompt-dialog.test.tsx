// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SystemPromptDialog } from './system-prompt-dialog'
import type { ApiAgent } from '@renderer/hooks/use-agents'

const mutateAsync = vi.fn().mockResolvedValue(undefined)

vi.mock('@renderer/hooks/use-agents', () => ({
  useUpdateAgent: () => ({ mutateAsync, isPending: false }),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAuthMode: false, canAdminAgent: () => true, rolesReady: true }),
}))

vi.mock('@renderer/components/ui/code-editor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <textarea data-testid="code-editor" value={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
}))

const INSTRUCTIONS = `# Agent Instructions

<!-- Add your preferences here -->
`

const agent = { slug: 'demo', instructions: INSTRUCTIONS } as ApiAgent

describe('SystemPromptDialog', () => {
  it('shares one prompt between Preview and Source and saves edits from either', async () => {
    const user = userEvent.setup()
    render(<SystemPromptDialog agent={agent} open onOpenChange={() => {}} />)

    const preview = screen.getByTestId('system-prompt-preview-editor')
    expect(screen.getByRole('heading', { name: 'Agent Instructions' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)

    await user.type(preview, 'Answer in English.')
    await user.click(screen.getByTestId('system-prompt-tab-source'))
    const source = screen.getByTestId('code-editor') as HTMLTextAreaElement
    expect(source.value).toContain('<!-- Add your preferences here -->')
    expect(source.value).toContain('Answer in English.')

    await user.type(source, '\n- **Escalate** billing questions.')
    await user.click(screen.getByTestId('system-prompt-tab-preview'))
    expect(screen.getByText('Escalate').tagName).toBe('STRONG')

    await user.click(screen.getByRole('button', { name: 'Save' }))
    const saved = mutateAsync.mock.lastCall![0].instructions as string
    expect(saved).toContain('Answer in English.')
    expect(saved).toContain('**Escalate** billing questions.')
  })
})
