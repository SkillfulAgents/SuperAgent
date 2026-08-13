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
  | 'wrong-bin'
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

const ALIAS_SPEC = /^(npm:|file:|link:|workspace:|git\+|github:|http:|https:|jsr:)/

export function unscopedPackageName(pkgName: string): string {
  const slash = pkgName.lastIndexOf('/')
  return slash === -1 ? pkgName : pkgName.slice(slash + 1)
}

function packageDir(dashboardDir: string, pkgName: string): string {
  return path.join(dashboardDir, 'node_modules', ...pkgName.split('/'))
}

function packageManifestPath(dashboardDir: string, pkgName: string): string {
  return path.join(packageDir(dashboardDir, pkgName), 'package.json')
}

function declaredBinMap(pkgName: string, bin: InstalledPackageManifest['bin']): Record<string, string> {
  if (bin === undefined) return {}
  if (typeof bin === 'string') {
    return bin.trim() === '' ? {} : { [unscopedPackageName(pkgName)]: bin }
  }
  const out: Record<string, string> = {}
  for (const [command, target] of Object.entries(bin)) {
    if (command.length > 0 && target.trim() !== '') out[command] = target
  }
  return out
}

async function binTargetResolves(
  binPath: string,
  expectedTarget: string,
): Promise<'ok' | 'missing' | 'dangling' | 'wrong'> {
  try {
    const st = await fs.promises.lstat(binPath)
    if (st.isSymbolicLink()) {
      let resolved: string
      try {
        resolved = await fs.promises.realpath(binPath)
        await fs.promises.access(resolved, fs.constants.X_OK)
      } catch {
        return 'dangling'
      }
      try {
        if (resolved !== (await fs.promises.realpath(expectedTarget))) return 'wrong'
      } catch {
        return 'wrong'
      }
      return 'ok'
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

function workspacePatterns(
  workspaces: string[] | { packages?: string[] } | undefined,
): string[] {
  if (!workspaces) return []
  return Array.isArray(workspaces) ? workspaces : (workspaces.packages ?? [])
}

async function expandWorkspacePattern(dashboardDir: string, pattern: string): Promise<string[]> {
  const trimmed = pattern.replace(/\/+$/, '')
  if (!trimmed || trimmed.includes('..')) return []
  const absDashboard = path.resolve(dashboardDir)
  if (trimmed.endsWith('/*') && !trimmed.slice(0, -2).includes('*')) {
    const parent = path.resolve(dashboardDir, trimmed.slice(0, -2))
    if (parent !== absDashboard && !parent.startsWith(absDashboard + path.sep)) return []
    try {
      const entries = await fs.promises.readdir(parent, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(parent, entry.name))
    } catch {
      return []
    }
  }
  if (trimmed.includes('*') || trimmed.includes('?')) return []
  const abs = path.resolve(dashboardDir, trimmed)
  if (abs !== absDashboard && !abs.startsWith(absDashboard + path.sep)) return []
  return [abs]
}

async function checkPackage(
  dashboardDir: string,
  pkgName: string,
  spec: string,
): Promise<PreflightResult> {
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
  if (parsed.data.name !== pkgName && !ALIAS_SPEC.test(spec)) {
    return {
      ok: false,
      reason: 'name-mismatch',
      package: pkgName,
      installedName: parsed.data.name,
    }
  }
  const pkgRoot = packageDir(dashboardDir, pkgName)
  for (const [command, relTarget] of Object.entries(declaredBinMap(pkgName, parsed.data.bin))) {
    const binPath = path.join(dashboardDir, 'node_modules', '.bin', command)
    const expected = path.resolve(pkgRoot, relTarget)
    const state = await binTargetResolves(binPath, expected)
    if (state === 'ok') continue
    const reason =
      state === 'dangling' ? 'dangling-bin' : state === 'wrong' ? 'wrong-bin' : 'missing-bin'
    return { ok: false, reason, package: pkgName, bin: command }
  }
  return { ok: true }
}

async function checkDirectDeps(dashboardDir: string): Promise<PreflightResult> {
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
  const deps = {
    ...(parsed.data.dependencies ?? {}),
    ...(parsed.data.devDependencies ?? {}),
  }
  for (const pkgName of new Set(Object.keys(deps))) {
    const result = await checkPackage(dashboardDir, pkgName, deps[pkgName] ?? '')
    if (!result.ok) return result
  }
  return { ok: true }
}

export async function preflightDashboardInstall(dashboardDir: string): Promise<PreflightResult> {
  const root = await checkDirectDeps(dashboardDir)
  if (!root.ok) return root

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

  const patterns = workspacePatterns(parsed.data.workspaces)
  if (patterns.length === 0) return { ok: true }

  try {
    const st = await fs.promises.stat(path.join(dashboardDir, 'node_modules'))
    if (!st.isDirectory()) return { ok: false, reason: 'missing-package' }
  } catch {
    return { ok: false, reason: 'missing-package' }
  }

  for (const pattern of patterns) {
    for (const wsDir of await expandWorkspacePattern(dashboardDir, pattern)) {
      if (path.resolve(wsDir) === path.resolve(dashboardDir)) continue
      try {
        await fs.promises.access(path.join(wsDir, 'package.json'))
      } catch {
        continue
      }
      const result = await checkDirectDeps(wsDir)
      if (!result.ok) return result
    }
  }
  return { ok: true }
}

export function formatPreflightFailure(result: PreflightFail): string {
  const bits: string[] = [result.reason]
  if (result.package) bits.push(`package=${result.package}`)
  if (result.installedName) bits.push(`installed=${result.installedName}`)
  if (result.bin) bits.push(`bin=${result.bin}`)
  return bits.join(' ')
}
