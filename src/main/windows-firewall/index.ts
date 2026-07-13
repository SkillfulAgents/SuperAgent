import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { captureException, captureMessage } from '@shared/lib/error-reporting'
import { firewallProbeOutputSchema } from './firewall-schema'

const execFileAsync = promisify(execFile)

/**
 * Detection and one-click remediation for Windows Firewall blocking the app.
 *
 * When the first-run "Allow access?" prompt is cancelled, Windows writes
 * persistent Inbound Block rules for the app's exe. Nothing visible breaks —
 * chat traffic is loopback/outbound — but every connection from the agent
 * container back into the host (browser launch, tool proxies) is silently
 * dropped, and neither side reports to Sentry. Detection reads the rules
 * (reading needs no elevation); remediation runs one elevated PowerShell
 * behind a standard UAC prompt.
 */

export interface FirewallStatus {
  /** false on non-Windows platforms — nothing to detect or fix. */
  supported: boolean
  blocked: boolean
  /** Display names of the enabled Inbound Block rules targeting our exe. */
  blockRuleNames: string[]
  /** Win11 24H2+: the Hyper-V firewall layer for WSL defaults inbound to Block. */
  hyperVInboundBlock: boolean
}

export type FixResult =
  | { ok: true; status: FirewallStatus }
  | { ok: false; reason: 'uac-declined' | 'failed' | 'unsupported'; detail?: string }

const NOT_SUPPORTED: FirewallStatus = {
  supported: false,
  blocked: false,
  blockRuleNames: [],
  hyperVInboundBlock: false,
}

/** WSL's VM-creator ID in the Hyper-V firewall — scoping to it means the fix
 *  never touches the machine's general firewall posture. */
const WSL_VM_CREATOR_ID = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'

/** Exit code the elevation wrapper uses for "could not elevate" (UAC declined
 *  or the account cannot elevate) — distinct from script failures. */
const ELEVATION_DECLINED_EXIT_CODE = 223

const DETECT_TIMEOUT_MS = 20_000
// The fix waits on a UAC prompt the user has to read and click through.
const FIX_TIMEOUT_MS = 120_000
const CACHE_TTL_MS = 5 * 60_000

let cached: { status: FirewallStatus; at: number } | null = null
let reportedToSentry = false

/** Escape a value for embedding inside a single-quoted PowerShell string. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function ruleDisplayName(): string {
  return `${path.basename(process.execPath, '.exe')} agent connections`
}

/**
 * Dev/test escape hatch: pretend the firewall is blocking so the banner and
 * fix flow can be exercised on any platform. Gated so a stray env var can
 * never fake a block in a shipped build (mirrors SUPERAGENT_TEST_UPDATES).
 */
function fakeBlockEnabled(): boolean {
  if (process.env.SUPERAGENT_FAKE_FIREWALL_BLOCK !== '1') return false
  if (process.versions.electron) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as typeof import('electron')
      return electron.app ? !electron.app.isPackaged : false
    } catch {
      return false
    }
  }
  // Web/dev-server context (no Electron runtime): dev builds only.
  return process.env.NODE_ENV !== 'production'
}

const FAKE_BLOCKED: FirewallStatus = {
  supported: true,
  blocked: true,
  blockRuleNames: ['fake-block-rule (SUPERAGENT_FAKE_FIREWALL_BLOCK)'],
  hyperVInboundBlock: false,
}
let fakeFixed = false

function detectionScript(): string {
  const exe = psQuote(process.execPath)
  // String-interpolating enum properties ("$($_.Action)") makes the comparison
  // and the JSON stable across PowerShell versions, which serialize raw enums
  // as numbers.
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$p = ${exe}`,
    `$rules = @(Get-NetFirewallApplicationFilter -Program $p | Get-NetFirewallRule | Where-Object { "$($_.Action)" -eq 'Block' -and "$($_.Enabled)" -eq 'True' -and "$($_.Direction)" -eq 'Inbound' })`,
    `$hv = @(Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore | Where-Object { "$($_.Name)" -eq '${WSL_VM_CREATOR_ID}' -and "$($_.DefaultInboundAction)" -eq 'Block' })`,
    `[pscustomobject]@{`,
    `  blockRules = @($rules | ForEach-Object { [pscustomobject]@{ name = "$($_.Name)"; displayName = "$($_.DisplayName)"; profile = "$($_.Profile)" } })`,
    `  hyperVInboundBlock = (@($hv).Count -gt 0)`,
    `} | ConvertTo-Json -Depth 4`,
  ].join('\n')
}

function fixScript(includeHyperV: boolean): string {
  const exe = psQuote(process.execPath)
  const name = psQuote(ruleDisplayName())
  const lines = [
    `$ErrorActionPreference = 'Stop'`,
    `$p = ${exe}`,
    // Only rules whose application filter targets OUR exe are touched.
    `Get-NetFirewallApplicationFilter -Program $p -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { "$($_.Action)" -eq 'Block' } | Remove-NetFirewallRule`,
    `if (-not (Get-NetFirewallRule -DisplayName ${name} -ErrorAction SilentlyContinue)) {`,
    `  New-NetFirewallRule -DisplayName ${name} -Direction Inbound -Program $p -Action Allow -Profile Any | Out-Null`,
    `}`,
  ]
  if (includeHyperV) {
    // Scoped to the WSL VM creator only — not the machine-wide default.
    lines.push(`Set-NetFirewallHyperVVMSetting -Name '${WSL_VM_CREATOR_ID}' -DefaultInboundAction Allow`)
  }
  lines.push(`exit 0`)
  return lines.join('\n')
}

async function runDetection(): Promise<FirewallStatus> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', detectionScript()],
      { timeout: DETECT_TIMEOUT_MS, windowsHide: true },
    )
    const parsed = firewallProbeOutputSchema.parse(JSON.parse(stdout.trim()))
    const status: FirewallStatus = {
      supported: true,
      blocked: parsed.blockRules.length > 0 || parsed.hyperVInboundBlock,
      blockRuleNames: parsed.blockRules.map((r) => r.displayName || r.name),
      hyperVInboundBlock: parsed.hyperVInboundBlock,
    }
    if (status.blocked && !reportedToSentry) {
      reportedToSentry = true
      captureMessage('Windows Firewall is blocking container-to-host connections', {
        tags: { component: 'firewall', operation: 'detect' },
        extra: {
          blockRuleNames: status.blockRuleNames,
          hyperVInboundBlock: status.hyperVInboundBlock,
          exePath: process.execPath,
        },
      })
    }
    return status
  } catch (error) {
    // A broken probe must never surface a false "blocked" banner. Report the
    // probe failure itself so we learn about machines where it can't run.
    captureException(error, {
      tags: { component: 'firewall', operation: 'detect' },
      extra: { exePath: process.execPath },
    })
    return { supported: true, blocked: false, blockRuleNames: [], hyperVInboundBlock: false }
  }
}

export async function getFirewallStatus(options?: { refresh?: boolean }): Promise<FirewallStatus> {
  if (fakeBlockEnabled()) return fakeFixed ? { ...FAKE_BLOCKED, blocked: false, blockRuleNames: [] } : FAKE_BLOCKED
  if (process.platform !== 'win32') return NOT_SUPPORTED
  if (!options?.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.status
  }
  const status = await runDetection()
  cached = { status, at: Date.now() }
  return status
}

/**
 * Remove our Block rules and add a program-scoped Allow rule via ONE elevated
 * PowerShell run (standard UAC consent). Returns the re-detected status on
 * success so the caller can confirm the block is actually gone.
 */
export async function fixFirewallBlock(): Promise<FixResult> {
  if (fakeBlockEnabled()) {
    fakeFixed = true
    return { ok: true, status: await getFirewallStatus() }
  }
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported' }

  const current = await getFirewallStatus({ refresh: true })
  if (!current.blocked) return { ok: true, status: current }

  const scriptPath = path.join(os.tmpdir(), `gamut-firewall-fix-${Date.now()}.ps1`)
  try {
    fs.writeFileSync(scriptPath, fixScript(current.hyperVInboundBlock), { mode: 0o600 })

    // Outer (non-elevated) PowerShell launches the elevated one so we get a
    // real UAC prompt and can distinguish "user declined" from "script failed".
    const wrapper = [
      `try {`,
      `  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','"${scriptPath}"')`,
      `  exit $p.ExitCode`,
      `} catch {`,
      `  exit ${ELEVATION_DECLINED_EXIT_CODE}`,
      `}`,
    ].join('\n')

    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', wrapper],
      { timeout: FIX_TIMEOUT_MS, windowsHide: true },
    )
  } catch (error) {
    const code = (error as { code?: number | string }).code
    if (code === ELEVATION_DECLINED_EXIT_CODE) {
      return { ok: false, reason: 'uac-declined' }
    }
    captureException(error, {
      tags: { component: 'firewall', operation: 'fix' },
      extra: { exePath: process.execPath },
    })
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
  } finally {
    try { fs.unlinkSync(scriptPath) } catch { /* ignore */ }
  }

  const status = await getFirewallStatus({ refresh: true })
  if (status.blocked) {
    // Elevated script "succeeded" but the block persists — treat as failure so
    // the banner stays honest.
    return { ok: false, reason: 'failed', detail: 'Block rules still present after fix' }
  }
  captureMessage('Windows Firewall block remediated via in-app fix', {
    tags: { component: 'firewall', operation: 'fix' },
  })
  return { ok: true, status }
}

/** Test-only: reset module-level caches between unit tests. */
export function __resetFirewallStateForTests(): void {
  cached = null
  reportedToSentry = false
  fakeFixed = false
}
