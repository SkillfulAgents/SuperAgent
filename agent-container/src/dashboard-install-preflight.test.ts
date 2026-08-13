import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  formatPreflightFailure,
  preflightDashboardInstall,
  unscopedPackageName,
} from './dashboard-install-preflight'

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2))
}

async function installPackage(
  dashboardDir: string,
  pkgName: string,
  fields: Record<string, unknown> = {},
): Promise<string> {
  const pkgDir = path.join(dashboardDir, 'node_modules', ...pkgName.split('/'))
  await writeJson(path.join(pkgDir, 'package.json'), { name: pkgName, version: '1.0.0', ...fields })
  return pkgDir
}

async function linkBin(dashboardDir: string, command: string, pkgDir: string): Promise<string> {
  const target = path.join(pkgDir, 'cli.js')
  await fs.promises.writeFile(target, '#!/usr/bin/env node\n')
  await fs.promises.chmod(target, 0o755)
  const binDir = path.join(dashboardDir, 'node_modules', '.bin')
  await fs.promises.mkdir(binDir, { recursive: true })
  const binPath = path.join(binDir, command)
  await fs.promises.symlink(target, binPath)
  return binPath
}

describe('unscopedPackageName', () => {
  it('strips the scope from a scoped package', () => {
    expect(unscopedPackageName('@scope/pkg')).toBe('pkg')
  })

  it('leaves an unscoped name unchanged', () => {
    expect(unscopedPackageName('left-pad')).toBe('left-pad')
  })
})

describe('preflightDashboardInstall', () => {
  let dashboardDir: string

  beforeEach(async () => {
    dashboardDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dash-preflight-'))
  })

  afterEach(async () => {
    await fs.promises.rm(dashboardDir, { recursive: true, force: true })
  })

  it('passes when there are no direct dependencies', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), { name: 'dash', dependencies: {} })
    await expect(preflightDashboardInstall(dashboardDir)).resolves.toEqual({ ok: true })
  })

  it('passes for healthy direct deps and declared bins', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      dependencies: { 'left-pad': '1.0.0' },
      devDependencies: { '@scope/pkg': '1.0.0' },
    })
    const left = await installPackage(dashboardDir, 'left-pad', { bin: './cli.js' })
    await linkBin(dashboardDir, 'left-pad', left)
    const scoped = await installPackage(dashboardDir, '@scope/pkg', { bin: { tool: './cli.js' } })
    await linkBin(dashboardDir, 'tool', scoped)
    await expect(preflightDashboardInstall(dashboardDir)).resolves.toEqual({ ok: true })
  })

  it('does not require a .bin check when the package has no bin', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      dependencies: { lodash: '4.0.0' },
    })
    await installPackage(dashboardDir, 'lodash')
    await expect(preflightDashboardInstall(dashboardDir)).resolves.toEqual({ ok: true })
  })

  it('resolves a scoped package under node_modules/@scope/pkg', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      dependencies: { '@scope/pkg': '1.0.0' },
    })
    await installPackage(dashboardDir, '@scope/pkg')
    await expect(preflightDashboardInstall(dashboardDir)).resolves.toEqual({ ok: true })
  })

  it('fails when node_modules is missing', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      dependencies: { 'left-pad': '1.0.0' },
    })
    const result = await preflightDashboardInstall(dashboardDir)
    expect(result).toEqual({
      ok: false,
      reason: 'missing-package',
      package: 'left-pad',
    })
  })

  it('fails when the installed manifest is not valid JSON', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      dependencies: { 'left-pad': '1.0.0' },
    })
    const pkgDir = path.join(dashboardDir, 'node_modules', 'left-pad')
    await fs.promises.mkdir(pkgDir, { recursive: true })
    await fs.promises.writeFile(path.join(pkgDir, 'package.json'), '{')
    await expect(preflightDashboardInstall(dashboardDir)).resolves.toEqual({
      ok: false,
      reason: 'unreadable-manifest',
      package: 'left-pad',
    })
  })

  it('fails when a direct dep directory or manifest is missing', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      dependencies: { 'left-pad': '1.0.0' },
    })
    await fs.promises.mkdir(path.join(dashboardDir, 'node_modules'), { recursive: true })
    const result = await preflightDashboardInstall(dashboardDir)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.package).toBe('left-pad')
  })

  it('fails when the installed manifest name does not match', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      dependencies: { 'left-pad': '1.0.0' },
    })
    await installPackage(dashboardDir, 'left-pad', { name: 'other' })
    const result = await preflightDashboardInstall(dashboardDir)
    expect(result).toEqual({
      ok: false,
      reason: 'name-mismatch',
      package: 'left-pad',
      installedName: 'other',
    })
  })

  it('accepts an npm alias whose installed name differs from the dependency key', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      dependencies: { 'alias-pkg': 'npm:left-pad@1.0.0' },
    })
    await installPackage(dashboardDir, 'alias-pkg', { name: 'left-pad' })
    await expect(preflightDashboardInstall(dashboardDir)).resolves.toEqual({ ok: true })
  })

  it('accepts a file: dependency whose installed name differs from the dependency key', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      dependencies: { 'local-pkg': 'file:../real-package' },
    })
    await installPackage(dashboardDir, 'local-pkg', { name: 'real-package' })
    await expect(preflightDashboardInstall(dashboardDir)).resolves.toEqual({ ok: true })
  })

  it('fails when a declared .bin entry is missing', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      dependencies: { 'open-slide': '1.0.0' },
    })
    await installPackage(dashboardDir, 'open-slide', { bin: './cli.js' })
    const result = await preflightDashboardInstall(dashboardDir)
    expect(result).toEqual({
      ok: false,
      reason: 'missing-bin',
      package: 'open-slide',
      bin: 'open-slide',
    })
  })

  it('fails when a declared .bin resolves to a different package', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      dependencies: { 'open-slide': '1.0.0', other: '1.0.0' },
    })
    await installPackage(dashboardDir, 'open-slide', { bin: './cli.js' })
    const other = await installPackage(dashboardDir, 'other', { bin: './cli.js' })
    await linkBin(dashboardDir, 'open-slide', other)
    await expect(preflightDashboardInstall(dashboardDir)).resolves.toEqual({
      ok: false,
      reason: 'wrong-bin',
      package: 'open-slide',
      bin: 'open-slide',
    })
  })

  it('fails when a declared .bin symlink is dangling', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      dependencies: { 'open-slide': '1.0.0' },
    })
    await installPackage(dashboardDir, 'open-slide', { bin: './cli.js' })
    const binDir = path.join(dashboardDir, 'node_modules', '.bin')
    await fs.promises.mkdir(binDir, { recursive: true })
    await fs.promises.symlink('/nonexistent/open-slide', path.join(binDir, 'open-slide'))
    const result = await preflightDashboardInstall(dashboardDir)
    expect(result).toEqual({
      ok: false,
      reason: 'dangling-bin',
      package: 'open-slide',
      bin: 'open-slide',
    })
  })

  it('fails when package.json is missing or invalid', async () => {
    await expect(preflightDashboardInstall(dashboardDir)).resolves.toEqual({
      ok: false,
      reason: 'invalid-package-json',
    })
    await fs.promises.writeFile(path.join(dashboardDir, 'package.json'), '{')
    await expect(preflightDashboardInstall(dashboardDir)).resolves.toEqual({
      ok: false,
      reason: 'invalid-package-json',
    })
  })

  it('fails a workspace dashboard when node_modules is missing', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      workspaces: ['packages/*'],
      scripts: { start: 'bun run --filter web start' },
    })
    await writeJson(path.join(dashboardDir, 'packages', 'web', 'package.json'), {
      name: 'web',
      dependencies: { lodash: '4.0.0' },
    })
    await expect(preflightDashboardInstall(dashboardDir)).resolves.toEqual({
      ok: false,
      reason: 'missing-package',
    })
  })

  it('checks direct deps inside workspace packages', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      workspaces: ['packages/*'],
    })
    await fs.promises.mkdir(path.join(dashboardDir, 'node_modules'), { recursive: true })
    await writeJson(path.join(dashboardDir, 'packages', 'web', 'package.json'), {
      name: 'web',
      dependencies: { lodash: '4.0.0' },
    })
    await expect(preflightDashboardInstall(dashboardDir)).resolves.toEqual({
      ok: false,
      reason: 'missing-package',
      package: 'lodash',
    })
    await installPackage(path.join(dashboardDir, 'packages', 'web'), 'lodash')
    await expect(preflightDashboardInstall(dashboardDir)).resolves.toEqual({ ok: true })
  })

  it('ignores mtime relationship between package.json and node_modules', async () => {
    await writeJson(path.join(dashboardDir, 'package.json'), {
      name: 'dash',
      dependencies: { lodash: '4.0.0' },
    })
    await installPackage(dashboardDir, 'lodash')
    const past = new Date(Date.now() - 60_000)
    await fs.promises.utimes(path.join(dashboardDir, 'node_modules'), past, past)
    await fs.promises.utimes(path.join(dashboardDir, 'package.json'), new Date(), new Date())
    await expect(preflightDashboardInstall(dashboardDir)).resolves.toEqual({ ok: true })
  })
})

describe('formatPreflightFailure', () => {
  it('joins reason with structured fields', () => {
    expect(
      formatPreflightFailure({
        ok: false,
        reason: 'missing-bin',
        package: 'open-slide',
        bin: 'open-slide',
      }),
    ).toBe('missing-bin package=open-slide bin=open-slide')
    expect(
      formatPreflightFailure({
        ok: false,
        reason: 'name-mismatch',
        package: 'left-pad',
        installedName: 'other',
      }),
    ).toBe('name-mismatch package=left-pad installed=other')
    expect(
      formatPreflightFailure({
        ok: false,
        reason: 'wrong-bin',
        package: 'open-slide',
        bin: 'open-slide',
      }),
    ).toBe('wrong-bin package=open-slide bin=open-slide')
    expect(formatPreflightFailure({ ok: false, reason: 'invalid-package-json' })).toBe(
      'invalid-package-json',
    )
  })
})
