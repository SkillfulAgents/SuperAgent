import * as fs from 'fs'
import * as path from 'path'
import {
  DashboardInstallManifestSchema,
  InstalledPackageManifestSchema,
  type InstalledPackageManifest,
} from './dashboard-install-preflight-schema'

export type PreflightOk = { ok: true }
export type PreflightFail = { ok: false; reason: string; package?: string; bin?: string }
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

async function checkPackage(dashboardDir: string, pkgName: string): Promise<PreflightResult> {
  const manifestPath = packageManifestPath(dashboardDir, pkgName)
  let raw: string
  try {
    raw = await fs.promises.readFile(manifestPath, 'utf-8')
  } catch {
    return { ok: false, reason: `missing package ${pkgName}`, package: pkgName }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, reason: `unreadable manifest for ${pkgName}`, package: pkgName }
  }
  const parsed = InstalledPackageManifestSchema.safeParse(json)
  if (!parsed.success) {
    return { ok: false, reason: `unreadable manifest for ${pkgName}`, package: pkgName }
  }
  if (parsed.data.name !== pkgName) {
    return {
      ok: false,
      reason: `installed name "${parsed.data.name}" !== "${pkgName}"`,
      package: pkgName,
    }
  }
  for (const command of declaredBins(pkgName, parsed.data.bin)) {
    const binPath = path.join(dashboardDir, 'node_modules', '.bin', command)
    const state = await binTargetResolves(binPath)
    if (state === 'ok') continue
    return {
      ok: false,
      reason: state === 'dangling' ? `dangling bin ${command}` : `missing bin ${command}`,
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
    return { ok: false, reason: 'package.json missing or invalid' }
  }
  const parsed = DashboardInstallManifestSchema.safeParse(json)
  if (!parsed.success) {
    return { ok: false, reason: 'package.json missing or invalid' }
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
  if (result.bin) bits.push(`bin=${result.bin}`)
  return bits.join(' ')
}
