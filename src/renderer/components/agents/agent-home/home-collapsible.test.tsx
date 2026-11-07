// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeCardLookContext, HomeCollapsible, HomePanel } from './home-collapsible'

// The stored open state (user setting agentHomeSectionsOpen): a fake settings document and its writes.
let storedSettings: { agentHomeSectionsOpen?: Record<string, boolean> } | undefined
const mutate = vi.fn()
vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: storedSettings }),
  useUpdateUserSettings: () => ({ mutate }),
}))

beforeEach(() => {
  storedSettings = {}
  mutate.mockReset()
})

function renderPanel(defaultOpen?: boolean) {
  return render(
    <HomePanel>
      <HomeCollapsible id="skills" title="Skills" defaultOpen={defaultOpen}>
        <p>Skill list</p>
      </HomeCollapsible>
    </HomePanel>,
  )
}

describe('HomeCollapsible', () => {
  it('keeps another surface independent of Agent Home section preferences', async () => {
    storedSettings = { agentHomeSectionsOpen: { skills: true } }
    const user = userEvent.setup()
    render(
      <HomeCardLookContext.Provider value={{ card: '', section: '', media: '', label: '', defaultOpen: false }}>
        <HomeCollapsible id="skills" title="Skills"><p>Skill list</p></HomeCollapsible>
      </HomeCardLookContext.Provider>,
    )
    expect(screen.queryByText('Skill list')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Skills' }))
    expect(screen.getByText('Skill list')).toBeVisible()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('starts collapsed, showing only its header row in the panel', () => {
    renderPanel()
    expect(screen.getByTestId('home-sections-panel')).toContainElement(screen.getByRole('button', { name: 'Skills' }))
    expect(screen.getByRole('button', { name: 'Skills' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Skill list')).not.toBeInTheDocument()
  })

  it('opens to its content when the header is clicked, and closes again', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('button', { name: 'Skills' }))
    expect(screen.getByText('Skill list')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Skills' }))
    expect(screen.queryByText('Skill list')).not.toBeInTheDocument()
  })

  it('shows its count beside the chevron, outside the header name', () => {
    render(
      <HomePanel>
        <HomeCollapsible id="skills" title="Skills" count={3}>
          <p>Skill list</p>
        </HomeCollapsible>
      </HomePanel>,
    )
    expect(screen.getByTestId('home-section-count')).toHaveTextContent('3')
    expect(screen.getByRole('button', { name: 'Skills' })).toBeInTheDocument()
  })

  it('shows no count until it is known', () => {
    renderPanel()
    expect(screen.queryByTestId('home-section-count')).not.toBeInTheDocument()
  })

  it('can start open', () => {
    renderPanel(true)
    expect(screen.getByText('Skill list')).toBeVisible()
  })

  it('opens as the user last left it', () => {
    storedSettings = { agentHomeSectionsOpen: { skills: true } }
    renderPanel()
    expect(screen.getByText('Skill list')).toBeVisible()
  })

  it('a stored state wins over the default', () => {
    storedSettings = { agentHomeSectionsOpen: { skills: false } }
    renderPanel(true)
    expect(screen.queryByText('Skill list')).not.toBeInTheDocument()
  })

  it('stores the state it is left in, merged into the other sections', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('button', { name: 'Skills' }))
    expect(screen.getByText('Skill list')).toBeVisible()
    const patch = mutate.mock.calls[0][0] as (current: object) => object
    expect(patch({ agentHomeSectionsOpen: { triggers: true } })).toEqual({ agentHomeSectionsOpen: { triggers: true, skills: true } })
  })
})
