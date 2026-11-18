// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Wsl2InstallGuide } from './wsl2-install-guide'

/**
 * The guide is about the computer that runs the API. Its PowerShell button acts
 * on this computer, so it may only appear when the two are the same one.
 */

const state = vi.hoisted(() => ({ host: true }))

vi.mock('@renderer/lib/capabilities', () => ({ canUseHostFeatures: () => state.host }))

beforeEach(() => {
  state.host = true
})

describe('Wsl2InstallGuide', () => {
  it('opens PowerShell for you when this computer is the one that needs WSL2', () => {
    render(<Wsl2InstallGuide onRefresh={() => {}} isRefreshing={false} />)

    expect(screen.getByRole('button', { name: 'Open PowerShell' })).toBeTruthy()
    expect(screen.getByText('Restart your computer, then reopen Gamut.')).toBeTruthy()
  })

  it('gives the steps to run on the other computer when this window can’t reach it', () => {
    state.host = false
    render(<Wsl2InstallGuide onRefresh={() => {}} isRefreshing={false} />)

    expect(screen.queryByRole('button', { name: 'Open PowerShell' })).toBeNull()
    expect(screen.getByText(/on the computer that runs Gamut/)).toBeTruthy()
    expect(screen.getByText('Open PowerShell as administrator.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'wsl --install' })).toBeTruthy()
    expect(screen.getByText('Restart that computer, then start Gamut on it again.')).toBeTruthy()
  })
})
