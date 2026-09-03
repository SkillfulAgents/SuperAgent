// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { FileTypeIcon, getExtension } from './file-type-icon'

function box(container: HTMLElement) {
  return container.querySelector('[data-file-icon-size]') as HTMLElement
}

describe('FileTypeIcon', () => {
  it('picks the lucide icon for each category', () => {
    const cases: [string, string, string][] = [
      ['report.pdf', 'document', 'file-text'],
      ['notes.md', 'text', 'file-text'],
      ['app.ts', 'code', 'file-code'],
      ['data.json', 'data', 'file-braces'],
      ['config.yml', 'config', 'file-sliders'],
      ['run.sh', 'shell', 'file-terminal'],
      ['sheet.xlsx', 'spreadsheet', 'file-spreadsheet'],
      ['deck.pptx', 'presentation', 'file-chart-line'],
      ['photo.png', 'image', 'file-image'],
      ['clip.mp4', 'video', 'file-play'],
      ['song.mp3', 'audio', 'file-play'],
      ['bundle.zip', 'archive', 'file-archive'],
      ['Inter.ttf', 'font', 'file-type'],
      ['part.stl', 'model', 'file-axis-3d'],
    ]
    for (const [name, category, icon] of cases) {
      const { container, unmount } = render(<FileTypeIcon filename={name} />)
      expect(box(container).dataset.fileCategory, name).toBe(category)
      expect(container.querySelector(`svg.lucide-${icon}`), name).not.toBeNull()
      unmount()
    }
  })

  it('falls back to the plain file icon for unknown types and dotless names', () => {
    for (const name of ['blob.xyz', 'Makefile']) {
      const { container, unmount } = render(<FileTypeIcon filename={name} />)
      expect(container.querySelector('svg.lucide-file'), name).not.toBeNull()
      expect(container.querySelector('text'), name).toBeNull()
      unmount()
    }
  })

  it('draws every icon at stroke width 1', () => {
    const { container } = render(<FileTypeIcon filename="app.ts" />)
    expect(container.querySelector('svg')).toHaveAttribute('stroke-width', '1')
  })

  it('sizes the box from the token and records it', () => {
    const { container } = render(<FileTypeIcon filename="a.ttf" size="xl" />)
    const el = box(container)
    expect(el.style.width).toBe('24px')
    expect(el.style.height).toBe('24px')
    expect(el.dataset.fileIconSize).toBe('xl')
    expect(el.dataset.fileExt).toBe('ttf')
  })

  it('renders the folder glyph', () => {
    const { container } = render(<FileTypeIcon filename="my-project" folder />)
    expect(container.querySelector('svg.lucide-folder')).not.toBeNull()
    expect(box(container).dataset.fileCategory).toBeUndefined()
  })
})

describe('getExtension', () => {
  it('lowercases the last dotted segment', () => {
    expect(getExtension('Photo.JPG')).toBe('jpg')
    expect(getExtension('archive.tar.gz')).toBe('gz')
    expect(getExtension('Makefile')).toBe('')
  })
})
