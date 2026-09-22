// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { FileTypeIcon } from './file-type-icon'

function box(container: HTMLElement) {
  return container.querySelector('[data-file-icon-size]') as HTMLElement
}

describe('FileTypeIcon', () => {
  it.each([
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
  ])('draws %s as a %s file', (name, category, icon) => {
    const { container } = render(<FileTypeIcon filename={name} />)
    expect(box(container).dataset.fileCategory).toBe(category)
    expect(container.querySelector(`svg.lucide-${icon}`)).not.toBeNull()
  })

  it.each([
    ['Makefile', 'code', 'file-code'],
    ['Dockerfile', 'config', 'file-sliders'],
    ['.gitignore', 'config', 'file-sliders'],
    ['README', 'text', 'file-text'],
    ['LICENSE', 'text', 'file-text'],
  ])('recognises the extensionless file %s', (name, category, icon) => {
    const { container } = render(<FileTypeIcon filename={name} />)
    expect(box(container).dataset.fileCategory).toBe(category)
    expect(container.querySelector(`svg.lucide-${icon}`)).not.toBeNull()
  })

  it.each([
    'blob.xyz',
    // an extensionless name is never read as an extension: this is a `key`
    // file, not a keynote deck, and `lock` is not a lockfile extension
    'key',
    'lock',
    'Procfile.staging',
  ])('falls back to the plain file icon for %s', (name) => {
    const { container } = render(<FileTypeIcon filename={name} />)
    expect(box(container).dataset.fileCategory).toBe('other')
    expect(container.querySelector('svg.lucide-file')).not.toBeNull()
  })

  it('classifies by the basename, not the path', () => {
    const { container } = render(<FileTypeIcon filename="/workspace/docs.v2/report.pdf" />)
    expect(box(container).dataset.fileCategory).toBe('document')
  })

  it('draws every icon at stroke width 1', () => {
    const { container } = render(<FileTypeIcon filename="app.ts" />)
    expect(container.querySelector('svg')).toHaveAttribute('stroke-width', '1')
  })

  it.each([
    ['sm', 'h-3.5 w-3.5'],
    ['md', 'h-4 w-4'],
    ['lg', 'h-5 w-5'],
    ['xl', 'h-6 w-6'],
  ] as const)('sizes the %s box from the token and records it', (size, classes) => {
    const { container } = render(<FileTypeIcon filename="a.ttf" size={size} />)
    const el = box(container)
    expect(el.className).toContain(classes)
    expect(el.dataset.fileIconSize).toBe(size)
  })

  it('takes its color from the caller, and defers to the surrounding text otherwise', () => {
    const { container: plain } = render(<FileTypeIcon filename="a.ts" />)
    expect(box(plain).className).not.toContain('text-')

    const { container: muted } = render(<FileTypeIcon filename="a.ts" className="text-muted-foreground" />)
    expect(box(muted).className).toContain('text-muted-foreground')
  })

  it('lets a caller override the box size', () => {
    const { container } = render(<FileTypeIcon filename="a.ts" size="xl" className="h-3 w-3" />)
    const el = box(container)
    expect(el.className).toContain('h-3 w-3')
    expect(el.className).not.toContain('h-6')
  })

  it('renders the folder glyph', () => {
    const { container } = render(<FileTypeIcon filename="my-project" folder />)
    expect(container.querySelector('svg.lucide-folder')).not.toBeNull()
    expect(box(container).dataset.fileCategory).toBeUndefined()
  })
})
