import { execFile, type ExecFileException } from 'child_process'
import path from 'path'
import { z } from 'zod'
// The parser alone: the package index drags in electron-updater's HTTP stack.
import { parseDn } from 'builder-util-runtime/out/rfc2253Parser'

// Upstream allows 20s, which slow machines exceed (see verifyUpdateSignature).
export const SIGNATURE_CHECK_TIMEOUT_MS = 3 * 60 * 1000

// Upstream's budget for the "can PowerShell run at all?" probe.
const POWERSHELL_PROBE_TIMEOUT_MS = 10_000

// The parts of Get-AuthenticodeSignature's output we read. Status 0 is Valid.
const authenticodeSignatureSchema = z.object({
  Status: z.number(),
  StatusMessage: z.string().nullish(),
  Path: z.string().nullish(),
  SignerCertificate: z.object({ Subject: z.string() }).nullish(),
})

function runPowerShell(command: string, timeout: number, { ignoreStderr = false }: { ignoreStderr?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    // Matches upstream: an empty PSModulePath and the UTF-8 code page avoid
    // module-load and umlaut-in-certificate failures (electron-builder #7127,
    // #8162), joined with & because a semicolon doesn't end `set`.
    execFile(
      'set "PSModulePath=" & chcp 65001 >NUL & powershell.exe',
      ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', command],
      { shell: true, timeout },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error?.killed) {
          reject(new Error(`Timed out after ${timeout / 1000}s verifying the update's code signature`))
        } else if (error) {
          reject(error)
        } else if (stderr && !ignoreStderr) {
          reject(new Error(`Cannot execute Get-AuthenticodeSignature, stderr: ${stderr}. Failing signature validation due to unknown stderr.`))
        } else {
          resolve(stdout)
        }
      },
    )
  })
}

/** True when PowerShell can't run ConvertTo-Json (missing, or older than 3.0). */
async function powerShellUnusable(): Promise<boolean> {
  try {
    // Upstream's execFileSync probe only fails on a process error, not stderr.
    // Diagnostics from a successful probe must not turn a failed signature
    // check into acceptance by incorrectly declaring PowerShell unusable.
    await runPowerShell('ConvertTo-Json test', POWERSHELL_PROBE_TIMEOUT_MS, { ignoreStderr: true })
    return false
  } catch {
    return true
  }
}

function matchesPublisher(publisherNames: string[], signerSubject: string): boolean {
  const subject = parseDn(signerSubject)
  return publisherNames.some((name) => {
    const dn = parseDn(name)
    // A full DN must match on every key it names; a bare name matches the CN.
    if (dn.size) return [...dn.keys()].every((key) => dn.get(key) === subject.get(key))
    return name === subject.get('CN')
  })
}

/**
 * Windows update signature check — electron-updater's default verifier with a
 * longer timeout.
 *
 * Before installing a downloaded update, electron-updater runs PowerShell's
 * `Get-AuthenticodeSignature` on the installer with a hard-coded 20s timeout.
 * On slow machines (VDIs, low-end laptops) hashing the ~285 MB installer while
 * Defender scans it takes longer, the process is killed, and the update fails
 * with an opaque "Command failed: … Get-AuthenticodeSignature …" — every such
 * Sentry event lands ~20s after the updater's "Verifying signature" log line.
 * That verifier isn't exported and its timeout isn't configurable, so this
 * mirrors electron-updater 6.7.3's `windowsExecutableCodeSignatureVerifier`
 * with the timeout raised and the PowerShell probe made async (upstream runs
 * it with execFileSync, freezing the main process). Upstream's Windows 7/8
 * branch is left out: Electron no longer runs there.
 *
 * Same contract as upstream: resolves null when the installer is validly signed
 * by one of `publisherNames`, resolves a reason string when it isn't
 * (electron-updater turns that into ERR_UPDATER_INVALID_SIGNATURE), rejects
 * when the check itself fails. `timeoutMs` exists for
 * scripts/verify-update-signature.ts; electron-updater passes two arguments.
 */
export async function verifyUpdateSignature(
  publisherNames: string[],
  updateFile: string,
  { timeoutMs = SIGNATURE_CHECK_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<string | null> {
  // The path sits in a single-quoted PowerShell string, where '' is the only
  // escape; without it a crafted file name could inject commands.
  const escapedPath = updateFile.replace(/'/g, "''")
  console.log(`[auto-updater] Verifying signature ${updateFile}`)
  const startedAt = Date.now()
  try {
    const stdout = await runPowerShell(
      `"Get-AuthenticodeSignature -LiteralPath '${escapedPath}' | ConvertTo-Json -Compress"`,
      timeoutMs,
    )
    console.log(`[auto-updater] Signature check finished in ${Date.now() - startedAt}ms`)
    const signature = authenticodeSignatureSchema.parse(JSON.parse(stdout))
    if (signature.Status === 0 && signature.SignerCertificate) {
      if (signature.Path && path.normalize(signature.Path) !== path.normalize(updateFile)) {
        throw new Error(`LiteralPath of ${path.normalize(signature.Path)} is different than ${path.normalize(updateFile)}`)
      }
      if (matchesPublisher(publisherNames, signature.SignerCertificate.Subject)) return null
    }
    return `publisherNames: ${publisherNames.join(' | ')}, status: ${signature.StatusMessage ?? signature.Status}, signer: ${signature.SignerCertificate?.Subject ?? 'none'}`
  } catch (err) {
    console.warn(`[auto-updater] Signature check failed after ${Date.now() - startedAt}ms:`, err)
    // Upstream skips the check rather than fail when PowerShell itself is
    // unusable; keep that so the timeout is the only behaviour change.
    if (await powerShellUnusable()) {
      console.warn('[auto-updater] Cannot execute PowerShell ConvertTo-Json; skipping signature validation')
      return null
    }
    throw err
  }
}
