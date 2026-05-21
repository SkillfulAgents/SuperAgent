// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeSkillsBrowseDialog } from './home-skills-browse-dialog'
import { renderWithProviders } from '@renderer/test/test-utils'
import type { ApiDiscoverableSkill } from '@shared/lib/types/api'

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(),
}))

function makeSkill(overrides: Partial<ApiDiscoverableSkill> & { name: string }): ApiDiscoverableSkill {
  return {
    skillsetId: 'set-a',
    skillsetName: 'Set A',
    description: `${overrides.name} description`,
    version: '1.0.0',
    path: `skills/${overrides.name}/SKILL.md`,
    ...overrides,
  }
}

const SKILLS_TWO_SETS: ApiDiscoverableSkill[] = [
  makeSkill({ name: 'alpha', skillsetId: 'set-a', skillsetName: 'Set A' }),
  makeSkill({
    name: 'beta',
    description: 'queries the beta service',
    skillsetId: 'set-a',
    skillsetName: 'Set A',
  }),
  makeSkill({ name: 'gamma', skillsetId: 'set-b', skillsetName: 'Set B' }),
]

function Harness({ skills }: { skills: ApiDiscoverableSkill[] }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button onClick={() => setOpen(true)}>__open</button>
      <button onClick={() => setOpen(false)}>__close</button>
      <HomeSkillsBrowseDialog
        open={open}
        onOpenChange={setOpen}
        agentSlug="agent-1"
        discoverableSkills={skills}
      />
    </>
  )
}

describe('HomeSkillsBrowseDialog', () => {
  // Real timers — userEvent + Radix portals + fakeTimers do not play nicely
  // here. The debounce is only 150ms; we just wait it out.
  const DEBOUNCE_MS = 150

  function setupUser() {
    return userEvent.setup()
  }

  function waitForDebounce() {
    return new Promise<void>((resolve) => setTimeout(resolve, DEBOUNCE_MS + 20))
  }

  it('renders every skill on initial open', () => {
    renderWithProviders(<Harness skills={SKILLS_TWO_SETS} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(screen.getByText('gamma')).toBeInTheDocument()
  })

  it('debounces search — filter only applies after the debounce window', async () => {
    const user = setupUser()
    renderWithProviders(<Harness skills={SKILLS_TWO_SETS} />)

    await user.type(screen.getByPlaceholderText('Search skills...'), 'alp')

    // Right after typing, the filter has not been applied yet.
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(screen.getByText('gamma')).toBeInTheDocument()

    // After the debounce window, only matching skills remain.
    await waitForDebounce()
    await waitFor(() => {
      expect(screen.queryByText('beta')).not.toBeInTheDocument()
    })
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByText('gamma')).not.toBeInTheDocument()
  })

  it('search matches description as well as name', async () => {
    const user = setupUser()
    renderWithProviders(<Harness skills={SKILLS_TWO_SETS} />)

    await user.type(screen.getByPlaceholderText('Search skills...'), 'queries')
    await waitForDebounce()

    await waitFor(() => {
      expect(screen.queryByText('alpha')).not.toBeInTheDocument()
    })
    expect(screen.getByText('beta')).toBeInTheDocument()
  })

  it('empty-state message uses the debounced query, not the typed one', async () => {
    const user = setupUser()
    renderWithProviders(<Harness skills={SKILLS_TWO_SETS} />)

    await user.type(screen.getByPlaceholderText('Search skills...'), 'zzz')
    // Debounce hasn't fired — the empty-state should not yet show "zzz".
    expect(screen.queryByText(/No skills matching "zzz"/)).not.toBeInTheDocument()

    await waitForDebounce()
    await waitFor(() => {
      expect(screen.getByText(/No skills matching "zzz"/)).toBeInTheDocument()
    })
  })

  it('skillset filter popover toggles a single set, indicator dot appears for partial selection', async () => {
    const user = setupUser()
    renderWithProviders(<Harness skills={SKILLS_TWO_SETS} />)

    // No dot visible while all skillsets are selected (default).
    const filterButton = screen.getByRole('button', { name: 'Filter by skillset' })
    expect(filterButton.querySelector('span.bg-primary')).toBeNull()

    await user.click(filterButton)
    // De-select Set B.
    await user.click(await screen.findByRole('button', { name: /Set B/ }))

    // Set B's `gamma` is now hidden, Set A skills remain.
    await waitFor(() => {
      expect(screen.queryByText('gamma')).not.toBeInTheDocument()
    })
    expect(screen.getByText('alpha')).toBeInTheDocument()

    // Indicator dot is now present (size < total).
    expect(filterButton.querySelector('span.bg-primary')).not.toBeNull()
  })

  it('shows pagination only when filtered results exceed page size', async () => {
    const many: ApiDiscoverableSkill[] = Array.from({ length: 31 }, (_, i) =>
      makeSkill({ name: `skill-${String(i).padStart(2, '0')}` })
    )

    const { rerender } = renderWithProviders(<Harness skills={many} />)
    expect(screen.getByText('1 / 2')).toBeInTheDocument()

    rerender(<Harness skills={many.slice(0, 30)} />)
    await waitFor(() => {
      expect(screen.queryByText('1 / 2')).not.toBeInTheDocument()
    })
  })

  it('resets to page 1 when the search query changes', async () => {
    const user = setupUser()
    const many: ApiDiscoverableSkill[] = Array.from({ length: 31 }, (_, i) =>
      makeSkill({ name: `skill-${String(i).padStart(2, '0')}` })
    )
    renderWithProviders(<Harness skills={many} />)

    // Advance to page 2.
    const nextBtn = screen.getAllByRole('button').find((b) => b.querySelector('.lucide-chevron-right'))
    expect(nextBtn).toBeDefined()
    await user.click(nextBtn!)
    expect(screen.getByText('2 / 2')).toBeInTheDocument()

    // Typing into search should reset to page 1 once debounce settles.
    await user.type(screen.getByPlaceholderText('Search skills...'), 'skill-0')
    await waitForDebounce()

    await waitFor(() => {
      // 10 matches (skill-00..skill-09) -> 1 page total, no pager.
      expect(screen.queryByText(/^[12] \/ \d/)).not.toBeInTheDocument()
    })
  })

  it('clears search, page, and filter when the dialog closes and reopens', async () => {
    const user = setupUser()
    renderWithProviders(<Harness skills={SKILLS_TWO_SETS} />)

    await user.type(screen.getByPlaceholderText('Search skills...'), 'alpha')
    await waitForDebounce()
    await waitFor(() => {
      expect(screen.queryByText('beta')).not.toBeInTheDocument()
    })

    // Close via Escape (the Radix overlay blocks clicks on the harness buttons).
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    // Reopen — input is empty, all skills visible again.
    await user.click(screen.getByText('__open'))
    expect(screen.getByPlaceholderText('Search skills...')).toHaveValue('')
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(screen.getByText('gamma')).toBeInTheDocument()
  })
})
