// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeCollapsible, HomePanel } from './home-collapsible'

function renderPanel(defaultOpen?: boolean) {
  return render(
    <HomePanel>
      <HomeCollapsible title="Skills" defaultOpen={defaultOpen}>
        <p>Skill list</p>
      </HomeCollapsible>
    </HomePanel>,
  )
}

describe('HomeCollapsible', () => {
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
        <HomeCollapsible title="Skills" count={3}>
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
})
