import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { optimizeServiceIcon } from '../../../../scripts/lib/optimize-service-icon'

const ICONS_DIR = path.resolve(process.cwd(), 'src/renderer/public/service-icons')

describe('service icon assets', () => {
  it('keeps every checked-in icon as a safe, scalable SVG document', () => {
    const iconFiles = readdirSync(ICONS_DIR)
      .filter((fileName) => fileName.endsWith('.svg'))
      .sort()

    // A sudden drop here usually means the public assets were omitted from a
    // checkout or accidentally removed in bulk.
    expect(iconFiles.length).toBeGreaterThanOrEqual(170)

    for (const fileName of iconFiles) {
      const source = readFileSync(path.join(ICONS_DIR, fileName), 'utf8')
      const root = source.match(/<svg\b[^>]*>/i)?.[0]
      const viewBox = root?.match(/\bviewBox="([^"]+)"/i)?.[1]

      expect(root, fileName).toBeDefined()
      expect(viewBox?.trim(), fileName).toMatch(
        /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[ ,]+-?(?:\d+(?:\.\d+)?|\.\d+)){3}$/,
      )
      expect(source, fileName).not.toMatch(/<script\b|<foreignObject\b|\son[a-z]+\s*=/i)
    }
  })

  it('keeps placeholder art out of the checked-in icons', () => {
    const iconFiles = readdirSync(ICONS_DIR)
      .filter((fileName) => fileName.endsWith('.svg'))
      .sort()

    // The logos API answers 200 with a generic grey grid placeholder for names it
    // holds no logo for, so a slug can silently acquire non-art that still parses
    // as a valid SVG. These two colors draw that grid and appear in no real mark.
    for (const fileName of iconFiles) {
      const source = readFileSync(path.join(ICONS_DIR, fileName), 'utf8').toLowerCase()
      const isPlaceholder = source.includes('#e4e4e7') && source.includes('#fafafa')
      expect(isPlaceholder, fileName).toBe(false)
    }
  })

  it('keeps checked-in icons normalized by the download pipeline', () => {
    const iconFiles = readdirSync(ICONS_DIR)
      .filter((fileName) => fileName.endsWith('.svg'))
      .sort()

    for (const fileName of iconFiles) {
      const source = readFileSync(path.join(ICONS_DIR, fileName), 'utf8')
      expect(optimizeServiceIcon(source), fileName).toBe(source)
    }
  })
})
