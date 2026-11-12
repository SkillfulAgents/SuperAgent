import * as fs from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import { HTML_PREVIEW_CSP } from '../html-preview'
import { CONVERTED, HTML_THEME_TOKENS, MERMAID_THEME, fencePage } from './fence-page'

describe('fencePage', () => {
  it('has the container convert mermaid and math into a fitted page, scripts off', () => {
    expect(fencePage('mermaid', 'A --> B')).toMatchObject({ scripts: false, fit: true, convert: { kind: 'mermaid', source: 'A --> B', at: CONVERTED, options: MERMAID_THEME } })
    expect(fencePage('math', 'E = mc^2')).toMatchObject({ scripts: false, convert: { kind: 'math', source: 'E = mc^2', options: { displayMode: true, throwOnError: true } } })
    expect(fencePage('math', 'x').html).toContain(CONVERTED)
  })

  it('wraps html in the app\'s preview policy and runs its scripts, with nothing to convert', () => {
    const page = fencePage('html', '<p>hi</p>')
    expect(page).toMatchObject({ scripts: true, fit: true })
    expect(page.convert).toBeUndefined()
    expect(page.html).toContain(HTML_PREVIEW_CSP)
    expect(page.html).toContain('<p>hi</p>')
  })
})

describe('the light theme copied from the app', () => {
  // The app's light theme: the declarations of the first `:root` block in its stylesheet.
  const css = fs.readFileSync(path.join(process.cwd(), 'src/renderer/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const root = css.match(/:root\s*{([^}]*)}/)?.[1] ?? ''
  const app = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]))

  it('still matches the app\'s colours in the diagram theme', () => {
    expect(MERMAID_THEME).toMatchObject({
      bg: `hsl(${app.background})`, fg: `hsl(${app.foreground})`, muted: `hsl(${app['muted-foreground']})`, accent: `hsl(${app.brand})`,
    })
  })

  it('still matches the app\'s tokens in the html preview theme', () => {
    for (const token of HTML_THEME_TOKENS.split(';')) {
      const [name, value] = token.split(':')
      expect([name, value]).toEqual([name, app[name.slice(2)]])
    }
  })
})
