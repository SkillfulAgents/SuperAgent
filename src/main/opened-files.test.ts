import { describe, it, expect } from 'vitest'
import { filesFromCommandLine, type CommandLineFileOpts } from './opened-files'

// Extraction logic is identical for every non-macOS platform, so the portable
// cases use platform 'linux' + POSIX paths (path.resolve is host-relative). The
// darwin / unpackaged gates are covered explicitly.
function opts(over: Partial<CommandLineFileOpts> = {}): CommandLineFileOpts {
  return {
    platform: 'linux',
    isPackaged: true,
    protocolScheme: 'superagent',
    workingDirectory: '/work',
    fileExists: () => true,
    ...over,
  }
}

/** An existence oracle that only recognizes the given absolute paths. */
function existsFor(...paths: string[]) {
  const set = new Set(paths)
  return (p: string) => set.has(p)
}

describe('filesFromCommandLine', () => {
  it('returns [] on macOS (open-file handles it there)', () => {
    expect(
      filesFromCommandLine(['exe', '/work/a.txt'], opts({ platform: 'darwin' })),
    ).toEqual([])
  })

  it('returns [] in unpackaged/dev builds', () => {
    expect(
      filesFromCommandLine(['electron', '/work/a.txt'], opts({ isPackaged: false })),
    ).toEqual([])
  })

  it('extracts existing files and drops argv[0] (the executable)', () => {
    const result = filesFromCommandLine(
      ['/work/Gamut', '/work/a.txt', '/work/b.png'],
      opts({ fileExists: existsFor('/work/Gamut', '/work/a.txt', '/work/b.png') }),
    )
    // argv[0] is sliced off even though it "exists".
    expect(result).toEqual(['/work/a.txt', '/work/b.png'])
  })

  it('skips flags / Electron switches', () => {
    const result = filesFromCommandLine(
      ['exe', '--enable-foo', '/work/a.txt', '-x'],
      opts({ fileExists: existsFor('/work/a.txt') }),
    )
    expect(result).toEqual(['/work/a.txt'])
  })

  it('skips deep-link protocol URLs', () => {
    const result = filesFromCommandLine(
      ['exe', 'superagent://open/thing', '/work/a.txt'],
      opts({ fileExists: existsFor('/work/a.txt') }),
    )
    expect(result).toEqual(['/work/a.txt'])
  })

  it('resolves relative args against the working directory', () => {
    const result = filesFromCommandLine(
      ['exe', 'doc.txt'],
      opts({ workingDirectory: '/work', fileExists: existsFor('/work/doc.txt') }),
    )
    expect(result).toEqual(['/work/doc.txt'])
  })

  it('filters out args that are not real files', () => {
    const result = filesFromCommandLine(
      ['exe', '/work/missing.txt'],
      opts({ fileExists: existsFor() }),
    )
    expect(result).toEqual([])
  })
})
