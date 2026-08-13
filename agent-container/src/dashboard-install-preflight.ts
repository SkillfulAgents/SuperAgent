import * as fs from 'fs'
import * as path from 'path'
import {
  DashboardInstallDepsSchema,
  InstalledPackageManifestSchema,
  type InstalledPackageManifest,
} from './dashboard-package-schema'

export type PreflightReason =
  | 'missing-package'
  | 'unreadable-manifest'
  | 'name-mismatch'
  | 'missing-bin'
  | 'dangling-bin'
  | 'invalid-package-json'

export type PreflightOk = { ok: true }
export type PreflightFail = {
  ok: false
  reason: PreflightReason
  package?: string
  bin?: string
  installedName?: string
}
export type PreflightResult = PreflightOk | PreflightFail

export function unscopedPackageName(pkgName: string): string {
  const slash = pkgName.lastIndexOf('/')
  return slash === -1 ? pkgName : pkgName.slice(slash + 1)
}

function packageManifestPath(dashboardDir: string, pkgName: string): string {
  return path.join(dashboardDir, 'node_modules', ...pkgName.split('/'), 'package.json')
}

function declaredBins(pkgName: string, bin: InstalledPackageManifest['bin']): string[] {
  if (bin === undefined) return []
  if (typeof bin === 'string') {
    return bin.trim() === '' ? [] : [unscopedPackageName(pkgName)]
  }
  return Object.keys(bin).filter((command) => command.length > 0)
}

async function binTargetResolves(binPath: string): Promise<'ok' | 'missing' | 'dangling'> {
  try {
    const st = await fs.promises.lstat(binPath)
    if (st.isSymbolicLink()) {
      try {
        const resolved = await fs.promises.realpath(binPath)
        await fs.promises.access(resolved, fs.constants.X_OK)
        return 'ok'
      } catch {
        return 'dangling'
      }
    }
    if (!st.isFile()) return 'missing'
    await fs.promises.access(binPath, fs.constants.X_OK)
    return 'ok'
  } catch {
    return 'missing'
  }
}

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

async function checkPackage(dashboardDir: string, pkgName: string): Promise<PreflightResult> {
  const manifestPath = packageManifestPath(dashboardDir, pkgName)
  let raw: string
  try {
    raw = await fs.promises.readFile(manifestPath, 'utf-8')
  } catch {
    return { ok: false, reason: 'missing-package', package: pkgName }
  }
  const json = parseJson(raw)
  const parsed = json === undefined ? undefined : InstalledPackageManifestSchema.safeParse(json)
  if (!parsed?.success) {
    return { ok: false, reason: 'unreadable-manifest', package: pkgName }
  }
  if (parsed.data.name !== pkgName) {
    return {
      ok: false,
      reason: 'name-mismatch',
      package: pkgName,
      installedName: parsed.data.name,
    }
  }
  for (const command of declaredBins(pkgName, parsed.data.bin)) {
    const binPath = path.join(dashboardDir, 'node_modules', '.bin', command)
    const state = await binTargetResolves(binPath)
    if (state === 'ok') continue
    return {
      ok: false,
      reason: state === 'dangling' ? 'dangling-bin' : 'missing-bin',
      package: pkgName,
      bin: command,
    }
  }
  return { ok: true }
}

export async function preflightDashboardInstall(dashboardDir: string): Promise<PreflightResult> {
  const pkgPath = path.join(dashboardDir, 'package.json')
  let json: unknown
  try {
    json = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8'))
  } catch {
    return { ok: false, reason: 'invalid-package-json' }
  }
  const parsed = DashboardInstallDepsSchema.safeParse(json)
  if (!parsed.success) {
    return { ok: false, reason: 'invalid-package-json' }
  }
  const names = [
    ...Object.keys(parsed.data.dependencies ?? {}),
    ...Object.keys(parsed.data.devDependencies ?? {}),
  ]
  for (const pkgName of new Set(names)) {
    const result = await checkPackage(dashboardDir, pkgName)
    if (!result.ok) return result
  }
  return { ok: true }
}

export function formatPreflightFailure(result: PreflightFail): string {
  const bits = [result.reason]
  if (result.package) bits.push(`package=${result.package}`)
  if (result.installedName) bits.push(`installed=${result.installedName}`)
  if (result.bin) bits.push(`bin=${result.bin}`)
  return bits.join(' ')
}
