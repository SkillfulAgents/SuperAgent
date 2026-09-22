// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GitFork } from 'lucide-react'
import { SessionProvenanceBanner } from './session-provenance-banner'

describe('SessionProvenanceBanner', () => {
  it('renders the sentence with no back button when back is omitted', () => {
    render(
      <SessionProvenanceBanner
        icon={GitFork}
        text={<>Session created by x-agent call from &quot;Gone Agent&quot;</>}
        testId="provenance-banner"
      />,
    )

    expect(screen.getByTestId('provenance-banner')).toHaveTextContent(
      'Session created by x-agent call from "Gone Agent"',
    )
    expect(screen.queryByRole('button')).toBeNull()
  })
})
