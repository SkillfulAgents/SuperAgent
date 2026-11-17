// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// A folder dropped or picked in the box: the shared composer waits on how to attach it.
const { dialog, onChoice, composerArgs } = vi.hoisted(() => ({ dialog: { open: false }, onChoice: vi.fn(), composerArgs: [] as Array<{ draftKey?: string; initialAttachments?: unknown[]; initialOptions?: { initialModel?: string } }> }))
vi.mock('@renderer/hooks/use-new-session-composer', () => ({
  useNewSessionComposer: (args: (typeof composerArgs)[number]) => (composerArgs.push(args), {
    composer: {
      attachments: [],
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
const carryover = vi.hoisted(() => ({ value: undefined as { attachments: unknown[]; model?: string } | undefined }))
vi.mock('@renderer/lib/new-session-carryover', () => ({ useNewSessionCarryover: () => carryover.value }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
// The box itself is the app's; this lists the cards it is handed.
vi.mock('@renderer/components/messages/chat-composer-box', () => ({
  ChatComposerBox: ({ attachments, textareaRef }: { attachments: Array<{ id: string; leaving?: boolean }>; textareaRef?: React.Ref<HTMLDivElement> }) => (
    <>
      <div ref={textareaRef} tabIndex={-1} aria-label="Message" />
      <ul>{attachments.map((card) => <li key={card.id}>{card.leaving ? `${card.id} leaving` : card.id}</li>)}</ul>
    </>
  ),
  FLOATING_COMPOSER_CLASS: '',
}))

import { TeamBrainHomeComposer } from './team-brain-home-composer'
import { focusSessionComposer } from '@renderer/components/messages/composer-focus'
import type { ApiAgent } from '@renderer/hooks/use-agents'

afterEach(() => {
  cleanup()
  dialog.open = false
  carryover.value = undefined
})

describe('TeamBrainHomeComposer', () => {
  it('is the agent\'s home composer, where the page\'s file drawer submits comments, and takes the focus Submit hands it', () => {
    const commentsIn = vi.fn()
    render(<TeamBrainHomeComposer agent={{ slug: 'team-brain' } as ApiAgent} onFocusRequested={commentsIn} />)
    expect(composerArgs.at(-1)?.draftKey).toBe('session:agent-home:team-brain')
    expect(screen.getByLabelText('Message')).not.toHaveFocus()
    expect(commentsIn).not.toHaveBeenCalled()
    act(() => focusSessionComposer('agent-home:team-brain'))
    expect(screen.getByLabelText('Message')).toHaveFocus()
    expect(commentsIn).toHaveBeenCalledTimes(1)
  })

  it('starts with what a stale session handed over when it started fresh, as Agent Home does', () => {
    carryover.value = { attachments: [{ id: 'notes.pdf' }], model: 'opus' }
    render(<TeamBrainHomeComposer agent={{ slug: 'team-brain' } as ApiAgent} />)
    expect(composerArgs.at(-1)?.initialAttachments).toEqual([{ id: 'notes.pdf' }])
    expect(composerArgs.at(-1)?.initialOptions?.initialModel).toBe('opus')
  })

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

  it('keeps one card at a time, and lets a card play its way out before it goes', () => {
    vi.useFakeTimers()
    try {
      const agent = { slug: 'team-brain' } as ApiAgent
      const page = { type: 'reference' as const, id: 'team-brain:eng/releases.md', name: 'releases.md', path: '/mounts/Team Brain/eng/releases.md', kind: 'file' as const, from: 'Team Brain' }
      const view = render(<TeamBrainHomeComposer agent={agent} reference={page} />)
      expect(screen.getAllByRole('listitem').map((card) => card.textContent)).toEqual(['team-brain:eng/releases.md'])
      // Set aside, it stays for its exit, then goes.
      view.rerender(<TeamBrainHomeComposer agent={agent} reference={null} />)
      expect(screen.getAllByRole('listitem').map((card) => card.textContent)).toEqual(['team-brain:eng/releases.md leaving'])
      // Chosen again during its exit, it is the one card, no longer leaving.
      view.rerender(<TeamBrainHomeComposer agent={agent} reference={page} />)
      expect(screen.getAllByRole('listitem').map((card) => card.textContent)).toEqual(['team-brain:eng/releases.md'])
      view.rerender(<TeamBrainHomeComposer agent={agent} reference={null} />)
      act(() => vi.advanceTimersByTime(260))
      expect(screen.queryAllByRole('listitem')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
