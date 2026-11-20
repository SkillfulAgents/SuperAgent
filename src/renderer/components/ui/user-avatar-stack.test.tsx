// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { MemberAgent } from '@shared/lib/types/agent-sharing'
import { UserAvatarStack } from './user-avatar-stack'

const person = { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' }
const agent = (slug: string, color: MemberAgent['avatar']['color'], shape: MemberAgent['avatar']['shape']): MemberAgent => (
  { slug, name: slug, avatar: { color, shape }, role: 'user', canMessage: true, readDecision: 'allow' }
)

describe('UserAvatarStack', () => {
  it('shows an agent as its orb on a round ground of its own rim colour', () => {
    const { container } = render(<UserAvatarStack users={[person]} agents={[agent('scout', 'tonal-cobalt', 'diamond')]} />)
    const face = container.querySelector<HTMLElement>('[data-agent-face="scout"]')!
    expect(face).toHaveClass('rounded-full')
    // Cobalt's rim (#1834DE) at 50%, so the sidebar shows through.
    expect(face.style.background).toBe('rgba(24, 52, 222, 0.5)')
    expect(face.style.width).toBe('18px')
    // The orb keeps its own colour and shape, smaller so its corners stay inside the circle.
    const orb = face.querySelector<HTMLElement>('[data-avatar-orb]')!
    expect(orb.dataset.avatarOrb).toBe('tonal-cobalt')
    expect(orb.dataset.avatarShape).toBe('diamond')
    expect(orb.style.width).toBe('13px')
  })

  it('leaves people as they are, ahead of the agents', () => {
    const { container } = render(<UserAvatarStack users={[person]} agents={[agent('scout', 'tonal-red', 'hexagon')]} />)
    const faces = [...container.firstElementChild!.children]
    expect(faces[0]).toHaveAttribute('aria-label', 'Ada Lovelace')
    expect(faces[0]).not.toHaveAttribute('data-agent-face')
    expect(faces[1]).toHaveAttribute('data-agent-face', 'scout')
  })

  it('cuts the next face out of an agent\'s ground, as it does a person\'s', () => {
    const { container } = render(<UserAvatarStack users={[]} agents={[agent('a', 'tonal-red', 'circle'), agent('b', 'tonal-black', 'arch')]} />)
    const [first, last] = [...container.querySelectorAll<HTMLElement>('[data-agent-face]')]
    expect(first.style.maskImage).toContain('radial-gradient')
    expect(last.style.maskImage).toBe('')
  })
})
