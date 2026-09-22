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
    // the icon carries no color of its own, so it takes the tile's hue
    expect(container.querySelector('[data-file-icon-size]')?.className).not.toContain('text-')
  })

  it.each([
    ['a category with no hue', { filename: 'bundle.zip' }],
    ['a folder', { filename: 'src', folder: true }],
    ['tinting turned off', { filename: 'a.png', tinted: false }],
  ])('stays neutral for %s', (_label, props) => {
    const { container } = render(<FileIconTile {...props} />)
    const el = tile(container)
    expect(el.className).toContain('text-muted-foreground')
    expect(el.className).not.toMatch(/text-(blue|indigo|emerald|orange|violet|pink)/)
    // data-tinted reports the hue actually applied, so an untinted tile has none
    expect(el.dataset.tinted).toBeUndefined()
  })

  it('uses the 20px icon token inside the 32px box', () => {
    const { container } = render(<FileIconTile filename="a.ts" />)
    expect(tile(container).className).toContain('h-8 w-8')
    expect(container.querySelector('[data-file-icon-size]')).toHaveAttribute('data-file-icon-size', 'lg')
  })
})
