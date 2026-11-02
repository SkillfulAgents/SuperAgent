// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { UnsupportedRenderer } from './unsupported-renderer'

describe('UnsupportedRenderer', () => {
  it('downloads from the URL it is given, and offers no download without one', () => {
    const { unmount } = render(<UnsupportedRenderer filePath="/Team Brain/data.bin" downloadUrl="/api/volume-definitions/v1/file?path=data.bin" />)
    expect(screen.getByRole('link')).toHaveAttribute('href', '/api/volume-definitions/v1/file?path=data.bin')
    unmount()

    render(<UnsupportedRenderer filePath="/workspace/data.bin" />)
    expect(screen.queryByRole('link')).toBeNull()
  })
})
