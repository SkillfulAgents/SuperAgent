// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// A folder dropped or picked in the box: the shared composer waits on how to attach it.
const { dialog, onChoice } = vi.hoisted(() => ({ dialog: { open: false }, onChoice: vi.fn() }))
vi.mock('@renderer/hooks/use-new-session-composer', () => ({
  useNewSessionComposer: () => ({
    composer: {
      mountDialog: { open: dialog.open, onChoice, folderName: 'Q3 notes' },
      chipDialog: null,
      dragHandlers: {},
      voiceInput: {},
    },
    composerOptions: {},
    createSession: { error: null },
    isDisabled: false,
  }),
}))
vi.mock('@renderer/hooks/use-runtime-status', () => ({ useRuntimeStatus: () => ({ data: undefined, isPending: true }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@renderer/components/messages/chat-composer-box', () => ({ ChatComposerBox: () => null, FLOATING_COMPOSER_CLASS: '' }))

import { TeamBrainHomeComposer } from './team-brain-home-composer'
import type { ApiAgent } from '@renderer/hooks/use-agents'

afterEach(cleanup)

describe('TeamBrainHomeComposer', () => {
  it('asks how to attach a folder, as Agent Home does, so the folder is not left waiting', async () => {
    const agent = { slug: 'team-brain' } as ApiAgent
    const page = render(<TeamBrainHomeComposer agent={agent} />)
    expect(screen.queryByText('How do you want to attach "Q3 notes"?')).toBeNull()
    dialog.open = true
    page.rerender(<TeamBrainHomeComposer agent={agent} />)
    expect(screen.getByText('How do you want to attach "Q3 notes"?')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Upload a copy'))
    expect(onChoice).toHaveBeenCalledWith('upload')
  })
})
