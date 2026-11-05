import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Runs the real bundled wrapper (scripts/lima-nerdctl) next to a fake limactl
// that prints what it was given, from a folder whose path has a space (an app
// bundle can live in one, e.g. "Gamut 2.app").

const REPO = path.resolve(__dirname, '../../../..')
const WRAPPER = path.join(REPO, 'scripts', 'lima-nerdctl')

const FAKE_LIMACTL = [
  '#!/bin/sh',
  'echo "PATH=$PATH"',
  'echo "LIMA_HOME=$LIMA_HOME"',
  'for a in "$@"; do echo "ARG=$a"; done',
  '',
].join('\n')

let root: string
let binDir: string

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lima-nerdctl-'))
  binDir = path.join(root, 'Gamut 2.app', 'Contents', 'Resources', 'lima', 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.copyFileSync(WRAPPER, path.join(binDir, 'lima-nerdctl'))
  fs.chmodSync(path.join(binDir, 'lima-nerdctl'), 0o755)
  fs.writeFileSync(path.join(binDir, 'limactl'), FAKE_LIMACTL, { mode: 0o755 })
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function run(args: string[], env: Record<string, string | undefined>) {
  return spawnSync(path.join(binDir, 'lima-nerdctl'), args, {
    encoding: 'utf-8',
    env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/Users/someone', ...env },
  })
}

describe('scripts/lima-nerdctl', () => {
  it('is executable in the repo, so the copy in the app bundle is too', () => {
    expect(fs.statSync(WRAPPER).mode & 0o111).toBe(0o111)
  })

  it('runs the limactl next to it with a system-only PATH, the app Lima home, and nerdctl args intact', () => {
    const result = run(['run', 'a b', '--format', '{{json .}}', "it's", ''], {
      SUPERAGENT_LIMA_HOME: '/Users/someone/.superagent/lima',
      SUPERAGENT_LIMA_VM: 'superagent',
    })

    expect(result.status).toBe(0)
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines[0]).toBe('PATH=/usr/bin:/bin:/usr/sbin:/sbin')
    expect(lines[1]).toBe('LIMA_HOME=/Users/someone/.superagent/lima')
    expect(lines.slice(2)).toEqual([
      'ARG=shell', 'ARG=superagent', 'ARG=--', 'ARG=sudo', 'ARG=nerdctl',
      'ARG=run', 'ARG=a b', 'ARG=--format', 'ARG={{json .}}', "ARG=it's", 'ARG=',
    ])
  })

  it('refuses to run without the Lima home instead of falling back to ~/.lima', () => {
    const result = run(['ps'], { SUPERAGENT_LIMA_VM: 'superagent' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('SUPERAGENT_LIMA_HOME is not set')
    expect(result.stdout).toBe('')
  })

  it('refuses to run without the VM name', () => {
    const result = run(['ps'], { SUPERAGENT_LIMA_HOME: '/Users/someone/.superagent/lima' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('SUPERAGENT_LIMA_VM is not set')
    expect(result.stdout).toBe('')
  })

  it('is packaged next to limactl', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'))
    const lima = pkg.build.extraResources.find((r: { from: string }) => r.from === 'build/lima')
    expect(lima.to).toBe('lima')
    expect(lima.filter).toContain('bin/lima-nerdctl')
    expect(fs.readFileSync(path.join(REPO, 'scripts', 'download-lima.sh'), 'utf-8'))
      .toMatch(/^install -m 755 "\$\(dirname "\$0"\)\/lima-nerdctl" "\$\{BIN_DIR\}\/lima-nerdctl"$/m)
  })
})
