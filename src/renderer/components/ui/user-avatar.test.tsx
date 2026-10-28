// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UserAvatar, userInitials } from './user-avatar'
vi.mock('@renderer/lib/env', () => ({ getApiBaseUrl: () => 'http://localhost:47891/cloud/test-key' }))

describe('UserAvatar', () => {
  it('uses the cloud API prefix for stored photos and recovers from a failed photo when the URL changes', () => {
    const user = { id: 'u1', name: 'Ada Lovelace', image: '/api/profile/images/00000000-0000-4000-8000-000000000001.png' }
    const { container, rerender } = render(<UserAvatar user={user} />)
    expect(container.querySelector('img')?.src).toContain('/cloud/test-key/api/profile/images/')
    fireEvent.error(container.querySelector('img')!)
    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toHaveTextContent('AL')
    rerender(<UserAvatar user={{ ...user, image: 'https://example.com/new.png' }} />)
    expect(container.querySelector('img')?.src).toBe('https://example.com/new.png')
  })

  it('uses a stable color across name changes and safe initials for incomplete profiles', () => {
    const { container, rerender } = render(<UserAvatar user={{ id: 'u1', name: 'Ada' }} />)
    const background = (container.firstChild as HTMLElement).style.background
    rerender(<UserAvatar user={{ id: 'u1', name: 'Grace' }} />)
    expect((container.firstChild as HTMLElement).style.background).toBe(background)
    expect(userInitials({ name: '  Ada   Byron Lovelace ' })).toBe('AL')
    expect(userInitials({ email: 'ada@example.com' })).toBe('AD')
    expect(userInitials({})).toBe('?')
  })
})
