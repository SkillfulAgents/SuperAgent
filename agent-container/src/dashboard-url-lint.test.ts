import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { lintDashboardSource, lintDashboardDir, formatUrlFindings } from './dashboard-url-lint'

describe('lintDashboardSource - flags client-side absolute URLs (the patterns that matter)', () => {
  it('flags fetch with single quotes, double quotes, and template literals', () => {
    expect(lintDashboardSource(`const r = await fetch('/api/data')`, 'index.js')).toHaveLength(1)
    expect(lintDashboardSource(`fetch("/x")`, 'a.js')).toHaveLength(1)
    expect(lintDashboardSource('fetch(`/x`)', 'a.js')).toHaveLength(1)
  })

  it('flags axios methods and direct axios calls', () => {
    expect(lintDashboardSource(`axios.get('/api/x')`, 'a.js')).toHaveLength(1)
    expect(lintDashboardSource(`axios.post('/api/x', body)`, 'a.js')).toHaveLength(1)
    expect(lintDashboardSource(`axios('/api/x')`, 'a.js')).toHaveLength(1)
  })

  it('flags EventSource streams', () => {
    expect(lintDashboardSource(`const es = new EventSource('/events')`, 'a.js')).toHaveLength(1)
  })

  it('flags absolute src and href attributes (single and double quoted)', () => {
    expect(lintDashboardSource(`<img src="/logo.png">`, 'i.html')).toHaveLength(1)
    expect(lintDashboardSource(`<link href="/style.css">`, 'i.html')).toHaveLength(1)
    expect(lintDashboardSource(`<a href='/page'>x</a>`, 'i.html')).toHaveLength(1)
  })

  it('flags absolute CSS url() incl. quotes and @font-face', () => {
    expect(lintDashboardSource(`background: url(/bg.png)`, 's.css')).toHaveLength(1)
    expect(lintDashboardSource(`background: url('/bg.png')`, 's.css')).toHaveLength(1)
    expect(lintDashboardSource(`@font-face { src: url("/f.woff2") }`, 's.css')).toHaveLength(1)
  })

  it('reports the correct 1-based line number and file', () => {
    const f = lintDashboardSource(`line1\nfetch('/api/x')\nline3`, 'a.js')
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ file: 'a.js', line: 2 })
  })

  it('flags uppercase HTML attributes (attribute names are case-insensitive)', () => {
    expect(lintDashboardSource(`<IMG SRC="/logo.png">`, 'i.html')).toHaveLength(1)
    expect(lintDashboardSource(`<a HREF="/page">x</a>`, 'i.html')).toHaveLength(1)
  })

  it('counts every site on a line, not just the first', () => {
    expect(lintDashboardSource(`fetch('/a'); fetch('/b')`, 'a.js')).toHaveLength(2)
  })
})

describe('lintDashboardSource - does NOT flag correct code (no crying wolf)', () => {
  it('ignores server-side route declarations and URL parsing', () => {
    expect(lintDashboardSource(`if (url.pathname === '/api/data') {}`, 'srv.js')).toHaveLength(0)
    expect(lintDashboardSource(`const url = new URL(req.url)`, 'srv.js')).toHaveLength(0)
  })

  it('does not treat non-listed calls (app.get, http.get) as client fetches', () => {
    expect(lintDashboardSource(`app.get('/api/data', handler)`, 'srv.js')).toHaveLength(0)
    expect(lintDashboardSource(`http.get('/api/data', cb)`, 'srv.js')).toHaveLength(0)
  })

  it('ignores relative URLs', () => {
    expect(lintDashboardSource(`fetch('api/data')`, 'a.js')).toHaveLength(0)
    expect(lintDashboardSource(`fetch('./api/data')`, 'a.js')).toHaveLength(0)
    expect(lintDashboardSource(`<img src="logo.png">`, 'i.html')).toHaveLength(0)
  })

  it('ignores absolute external URLs and protocol-relative URLs', () => {
    expect(lintDashboardSource(`fetch('https://api.example.com/x')`, 'a.js')).toHaveLength(0)
    expect(lintDashboardSource(`<script src="//cdn.example.com/lib.js"></script>`, 'i.html')).toHaveLength(0)
    expect(lintDashboardSource(`background: url(https://cdn/x.png)`, 's.css')).toHaveLength(0)
  })

  it('ignores anchors and data URIs', () => {
    expect(lintDashboardSource(`<a href="#top">x</a>`, 'i.html')).toHaveLength(0)
    expect(lintDashboardSource(`<img src="data:image/png;base64,AAA">`, 'i.html')).toHaveLength(0)
  })

  it('does not fire inside identifiers like curl() or the JS new URL() constructor', () => {
    expect(lintDashboardSource(`const r = curl('/api/data')`, 'a.js')).toHaveLength(0)
    expect(lintDashboardSource(`const u = new URL('/api/x', location.href)`, 'a.js')).toHaveLength(0)
  })
})

describe('lintDashboardSource - documented heuristic limitations (locked intentionally)', () => {
  it('keeps CSS url() case-sensitive to avoid flagging new URL(), so uppercase CSS URL() is a known miss', () => {
    expect(lintDashboardSource(`.hero { background: URL(/bg.png); }`, 's.css')).toHaveLength(0)
  })
})

describe('lintDashboardDir', () => {
  const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dashlint-'))

  it('scans source files and skips node_modules + non-source files', () => {
    const dir = mkdir()
    fs.writeFileSync(path.join(dir, 'index.js'), `fetch('/api/x')`)
    fs.mkdirSync(path.join(dir, 'node_modules'))
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), `fetch('/api/y')`)
    fs.writeFileSync(path.join(dir, 'package.json'), `{"name":"x"}`)
    const f = lintDashboardDir(dir)
    expect(f).toHaveLength(1)
    expect(f[0].file).toBe('index.js')
  })

  it('reports nested files with a relative path', () => {
    const dir = mkdir()
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src', 'app.js'), `fetch('/api/x')`)
    const f = lintDashboardDir(dir)
    expect(f).toHaveLength(1)
    expect(f[0].file).toBe(path.join('src', 'app.js'))
  })

  it('returns empty for a clean dashboard', () => {
    const dir = mkdir()
    fs.writeFileSync(path.join(dir, 'index.js'), `fetch('api/x')`)
    expect(lintDashboardDir(dir)).toHaveLength(0)
  })
})

describe('formatUrlFindings', () => {
  it('names each file:line, mentions 404, and exempts server routes', () => {
    const out = formatUrlFindings([
      { file: 'index.js', line: 417, kind: 'network-call', snippet: `fetch('/api/test-write')` },
    ])
    expect(out).toContain('index.js:417')
    expect(out).toContain('404')
    expect(out.toLowerCase()).toContain('relative')
    expect(out).toContain('url.pathname')
  })
})
