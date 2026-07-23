// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeExtras } from './home-extras'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openFolder: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ openFolder: mocks.openFolder }),
}))

describe('HomeExtras', () => {
  it('opens Agent Directory in the built-in folder browser', async () => {
    const user = userEvent.setup()
    render(<HomeExtras agentSlug="test-agent" />)

    await user.click(screen.getByTestId('home-agent-directory-open-browser'))

    expect(mocks.openFolder).toHaveBeenCalledWith('/workspace', 'test-agent')
    expect(screen.getByText('Agent Directory')).toBeVisible()
  })
})
