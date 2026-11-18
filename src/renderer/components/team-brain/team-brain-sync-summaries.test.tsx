// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FilePreviewProvider, useFilePreview } from '@renderer/context/file-preview-context'
import { useDraft } from '@renderer/context/drafts-context'
import { renderWithProviders } from '@renderer/test/test-utils'
import { parseSyncSummary } from '@renderer/lib/team-brain/team-brain-syncs'
import { TeamBrainSyncSummaries } from './team-brain-sync-summaries'

const ID = '_brain/syncs/2026-11-03 0009.md'
const SUMMARY = `---
type: team-brain-sync
at: 2026-11-03T00:09:00-08:00
---
## Changes
- Filed the renewal thread.

## Needs you
### Blocked
- Reconnect Slack.
### To decide
- Dana: is the renewal call on hold or live?
`

function Draft() {
  const [draft] = useDraft<string>('session:agent-home:brain')
  const { commentsFor } = useFilePreview()
  return <output data-testid="draft" data-stored={commentsFor(ID, 'brain').length}>{draft}</output>
}

function renderSummaries() {
  const sync = parseSyncSummary(ID, SUMMARY)!
  renderWithProviders(
    <FilePreviewProvider sessionId="agent-home:brain" commentsEnabled>
      <Draft />
      <TeamBrainSyncSummaries syncs={[sync]} agentSlug="brain" onOpenFile={() => {}} onOpenSession={() => {}} />
    </FilePreviewProvider>,
  )
}

describe('TeamBrainSyncSummaries comments', () => {
  it('sends a comment straight to the composer, on its line in the summary file', async () => {
    renderSummaries()
    fireEvent.pointerMove(screen.getByText('Dana: is the renewal call on hold or live?'))
    fireEvent.keyDown(document.body, { key: 'c' })

    const box = screen.getByPlaceholderText('Add your comment...')
    fireEvent.change(box, { target: { value: 'Live since 10-30.' } })
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })

    await waitFor(() => expect(screen.getByTestId('draft').textContent).toBe(
      'File feedback on `2026-11-03 0009.md`:\n\nLine 12: > "Dana: is the renewal call on hold or live?"\nLive since 10-30.',
    ))
    // Nothing stays behind on the card: no box, and no comment kept for the drawer's list.
    expect(screen.queryByPlaceholderText('Add your comment...')).toBeNull()
    expect(screen.getByTestId('draft')).toHaveAttribute('data-stored', '0')
  })
})
