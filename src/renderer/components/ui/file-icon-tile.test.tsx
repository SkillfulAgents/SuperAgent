// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { FileIconTile } from './file-icon-tile'

function tile(container: HTMLElement) {
  return container.firstElementChild as HTMLElement
}

describe('FileIconTile', () => {
  it('colors the icon stroke by category on a neutral box', () => {
    const { container } = render(<FileIconTile filename="sheet.xlsx" />)
    const el = tile(container)
    expect(el.className).toContain('bg-muted/50')
    expect(el.className).toContain('text-emerald-700')
    expect(el.className).not.toMatch(/bg-emerald/)
    expect(el.dataset.tinted).toBe('true')
    // the icon defers to the tile's color instead of its own muted default
    expect(container.querySelector('[data-file-icon-size]')?.className).toContain('text-inherit')
  })

  it('stays neutral for categories without a hue, folders, and when tinting is off', () => {
    for (const props of [{ filename: 'bundle.zip' }, { filename: 'src', folder: true }, { filename: 'a.png', tinted: false }]) {
      const { container, unmount } = render(<FileIconTile {...props} />)
      const el = tile(container)
      expect(el.className, JSON.stringify(props)).toContain('text-muted-foreground')
      expect(el.className, JSON.stringify(props)).not.toMatch(/text-(blue|indigo|emerald|orange|violet|pink)/)
      unmount()
    }
  })

  it('uses the 20px icon token inside the 32px box', () => {
    const { container } = render(<FileIconTile filename="a.ts" />)
    expect(tile(container).className).toContain('h-8 w-8')
    expect(container.querySelector('[data-file-icon-size]')).toHaveAttribute('data-file-icon-size', 'lg')
  })
})
