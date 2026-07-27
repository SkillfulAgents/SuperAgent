// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetApiTargetForTest, setActiveTarget } from '@renderer/lib/api-target'
import { CloudModeIndicator } from './cloud-mode-indicator'

/**
 * Two windows of this app look identical, and one of them may be the
 * organization's production Superagent. The marker is what stops someone
 * deleting the wrong agent.
 */

beforeEach(() => {
  _resetApiTargetForTest()
})

afterEach(() => {
  _resetApiTargetForTest()
})

describe('CloudModeIndicator', () => {
  it('marks the window while driving the cloud workspace', () => {
    setActiveTarget('cloud', null)
    render(<CloudModeIndicator />)

    expect(screen.getByTestId('cloud-mode-indicator')).toBeInTheDocument()
    expect(screen.getByText('Cloud workspace')).toBeInTheDocument()
  })

  it('stays out of the way entirely on the local target', () => {
    setActiveTarget('local', null)
    render(<CloudModeIndicator />)

    expect(screen.queryByTestId('cloud-mode-indicator')).not.toBeInTheDocument()
  })

  it('never intercepts pointer events', () => {
    // It overlaps the window drag region and the native traffic lights. A
    // marker that swallowed clicks there would be worse than no marker.
    setActiveTarget('cloud', null)
    render(<CloudModeIndicator />)

    expect(screen.getByTestId('cloud-mode-indicator').className).toContain('pointer-events-none')
  })

  it('is hidden from assistive tech, being decoration over real content', () => {
    setActiveTarget('cloud', null)
    render(<CloudModeIndicator />)

    expect(screen.getByTestId('cloud-mode-indicator')).toHaveAttribute('aria-hidden', 'true')
  })
})
