// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { AgentAvatar, agentAvatarId } from './agent-avatar'
import { AgentAvatarPicker } from './agent-avatar-picker'
import { setAvatarChoice } from './avatar-choice-store'
import { avatarForId } from './avatar-ids'
import { OFFERED_ORBS } from './avatar-orbs'
import { ORB_SHAPES } from './orb-shapes'

const shapeOf = (testId: string) =>
  screen.getByTestId(testId).querySelector('[data-avatar-shape]')?.getAttribute('data-avatar-shape')

const orbOf = (testId: string) =>
  screen.getByTestId(testId).querySelector('[data-avatar-orb]')?.getAttribute('data-avatar-orb')

// Each agent's own colour and shape, from its slug.
const own = (slug: string) => avatarForId(agentAvatarId(slug))!

function Harness() {
  return (
    <>
      <AgentAvatarPicker slug="second" agentName="Second" />
      <span data-testid="first">
        <AgentAvatar slug="first" />
      </span>
      <span data-testid="second">
        <AgentAvatar slug="second" />
      </span>
    </>
  )
}

describe('AgentAvatarPicker', () => {
  beforeEach(() => localStorage.clear())

  it('shows each agent its own colour and shape, from its slug', () => {
    render(<Harness />)
    expect(orbOf('first')).toBe(own('first').orb.name)
    expect(shapeOf('first')).toBe(own('first').shape.name)
    expect(orbOf('second')).toBe(own('second').orb.name)
    expect(shapeOf('second')).toBe(own('second').shape.name)
  })

  it('opens on the agent’s own shape and colour', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: "Change Second's avatar" }))
    expect(screen.getByRole('button', { name: own('second').shape.label })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: own('second').orb.label })).toHaveAttribute('aria-pressed', 'true')
  })

  const openPicker = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: "Change Second's avatar" }))
  // The picker has no buttons of its own: closing it keeps the draft.
  const close = (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')
  const pickerOpen = () => screen.queryByRole('button', { name: ORB_SHAPES[0].label }) !== null
  // A colour and shape that differ from the agent's own, whatever its slug gives it.
  const otherColour = () => OFFERED_ORBS.find(orb => orb !== own('second').orb)!
  const otherShape = () => ORB_SHAPES.find(shape => shape !== own('second').shape)!

  it('offers every colour, previews a pick as a draft, and applies it on close', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await openPicker(user)
    for (const orb of OFFERED_ORBS) expect(screen.getByRole('button', { name: orb.label })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: otherColour().label }))
    expect(screen.getByRole('button', { name: otherColour().label })).toHaveAttribute('aria-pressed', 'true')
    // A draft: the avatar being edited shows it in place; elsewhere the agent doesn't wear it yet.
    expect(orbOf('agent-avatar-picker')).toBe(otherColour().name)
    expect(orbOf('second')).toBe(own('second').orb.name)

    await close(user)
    expect(pickerOpen()).toBe(false)
    expect(orbOf('second')).toBe(otherColour().name)
  })

  it('keeps the draft when clicking out of the picker', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: otherShape().label }))
    await user.click(document.body)
    expect(pickerOpen()).toBe(false)
    expect(shapeOf('second')).toBe(otherShape().name)
    expect(shapeOf('agent-avatar-picker')).toBe(otherShape().name)
  })

  it('stores nothing when closed without a change', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await openPicker(user)
    await close(user)
    expect(Object.keys(localStorage).filter(name => name.startsWith('agent-avatar-choices.'))).toEqual([])
  })

  it('picks shape and colour independently, and remembers them', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Harness />)
    await openPicker(user)
    for (const shape of ORB_SHAPES) expect(screen.getByRole('button', { name: shape.label })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: otherShape().label }))
    expect(shapeOf('agent-avatar-picker')).toBe(otherShape().name)
    expect(orbOf('agent-avatar-picker')).toBe(own('second').orb.name) // colour kept

    await user.click(screen.getByRole('button', { name: otherColour().label }))
    expect(shapeOf('agent-avatar-picker')).toBe(otherShape().name) // shape kept
    expect(screen.getByRole('button', { name: otherShape().label })).toHaveAttribute('aria-pressed', 'true')
    await close(user)

    unmount()
    render(<Harness />)
    expect(shapeOf('second')).toBe(otherShape().name)
    expect(orbOf('second')).toBe(otherColour().name)
  })

  it('stores nothing when the agent’s own look is picked back', async () => {
    setAvatarChoice('second', `orb:${otherColour().name}`)
    const user = userEvent.setup()
    render(<Harness />)
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: own('second').shape.label }))
    await user.click(screen.getByRole('button', { name: own('second').orb.label }))
    await close(user)
    expect(orbOf('second')).toBe(own('second').orb.name)
    const key = Object.keys(localStorage).find(name => name.startsWith('agent-avatar-choices.'))!
    expect(localStorage.getItem(key)).not.toContain('second')
  })

  it('falls back to the agent’s own avatar for a pick this build doesn’t know', () => {
    setAvatarChoice('second', 'orb:tonal-grey')
    render(<Harness />)
    expect(orbOf('second')).toBe(own('second').orb.name)
    expect(shapeOf('second')).toBe(own('second').shape.name)
  })
})
