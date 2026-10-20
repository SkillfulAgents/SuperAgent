import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFile } from 'child_process'
import { verifyUpdateSignature, SIGNATURE_CHECK_TIMEOUT_MS } from './update-signature'

vi.mock('child_process', () => ({ execFile: vi.fn() }))

const UPDATE_FILE = 'C:\\Users\\dave\\AppData\\Local\\superagent-updater\\pending\\temp-Gamut-0.5.45-Setup.exe'
// The release installer's signer, as Get-AuthenticodeSignature formats it.
const SIGNER = 'CN=Datawizz Inc., O=Datawizz Inc., L=San Francisco, S=California, C=US'

type Outcome = { error?: Partial<Error & { killed: boolean }>; stdout?: string; stderr?: string }

/**
 * Stand in for PowerShell: `signature` answers the Get-AuthenticodeSignature
 * call, `probe` the "can PowerShell run at all?" ConvertTo-Json probe.
 */
function powershell({ signature, probe = { stdout: '"test"' } }: { signature: Outcome; probe?: Outcome }) {
  vi.mocked(execFile).mockImplementation(((_file: string, args: string[], _opts: unknown, cb: any) => {
    const outcome = args.at(-1) === 'ConvertTo-Json test' ? probe : signature
    const error = outcome.error ? Object.assign(new Error(outcome.error.message ?? 'Command failed'), outcome.error) : null
    cb(error, outcome.stdout ?? '', outcome.stderr ?? '')
  }) as any)
}

function signatureJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    Status: 0,
    StatusMessage: 'Signature verified.',
    Path: UPDATE_FILE,
    SignerCertificate: { Subject: SIGNER },
    ...overrides,
  })
}

describe('verifyUpdateSignature', () => {
  beforeEach(() => {
    vi.mocked(execFile).mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('accepts an installer validly signed by the publisher, allowing far more than upstream 20s', async () => {
    powershell({ signature: { stdout: signatureJson() } })

    await expect(verifyUpdateSignature(['Datawizz Inc.'], UPDATE_FILE)).resolves.toBeNull()

    const [, args, opts] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[], { timeout: number }]
    expect(args.at(-1)).toBe(`"Get-AuthenticodeSignature -LiteralPath '${UPDATE_FILE}' | ConvertTo-Json -Compress"`)
    expect(opts.timeout).toBe(SIGNATURE_CHECK_TIMEOUT_MS)
    expect(SIGNATURE_CHECK_TIMEOUT_MS).toBeGreaterThan(20_000)
  })

  it('escapes single quotes in the path so it cannot break out of the PowerShell string', async () => {
    const file = "C:\\Users\\o'brien\\temp-Gamut-Setup.exe"
    powershell({ signature: { stdout: signatureJson({ Path: file }) } })

    await expect(verifyUpdateSignature(['Datawizz Inc.'], file)).resolves.toBeNull()
    const [, args] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[]]
    expect(args.at(-1)).toContain("-LiteralPath 'C:\\Users\\o''brien\\temp-Gamut-Setup.exe'")
  })

  it('matches a full distinguished name on every key it names', async () => {
    powershell({ signature: { stdout: signatureJson() } })
    await expect(verifyUpdateSignature(['CN=Datawizz Inc., C=US'], UPDATE_FILE)).resolves.toBeNull()

    powershell({ signature: { stdout: signatureJson() } })
    await expect(verifyUpdateSignature(['CN=Datawizz Inc., C=GB'], UPDATE_FILE)).resolves.toMatch(/signer: CN=Datawizz Inc\./)
  })

  it('returns a reason when another publisher signed the installer', async () => {
    powershell({ signature: { stdout: signatureJson({ SignerCertificate: { Subject: 'CN=Someone Else' } }) } })

    const reason = await verifyUpdateSignature(['Datawizz Inc.'], UPDATE_FILE)
    expect(reason).toContain('publisherNames: Datawizz Inc.')
    expect(reason).toContain('signer: CN=Someone Else')
  })

  it('returns a reason when the signature is not valid', async () => {
    powershell({ signature: { stdout: signatureJson({ Status: 1, StatusMessage: 'The contents of the file may have been tampered with.' }) } })

    await expect(verifyUpdateSignature(['Datawizz Inc.'], UPDATE_FILE)).resolves.toMatch(/tampered/)
  })

  it('rejects when PowerShell reports a different file than the one checked', async () => {
    powershell({ signature: { stdout: signatureJson({ Path: 'C:\\elsewhere\\Setup.exe' }) } })

    await expect(verifyUpdateSignature(['Datawizz Inc.'], UPDATE_FILE)).rejects.toThrow(/LiteralPath of .*elsewhere/)
  })

  it('rejects with a readable message when the check times out', async () => {
    powershell({ signature: { error: { message: 'Command failed: …', killed: true } } })

    await expect(verifyUpdateSignature(['Datawizz Inc.'], UPDATE_FILE)).rejects.toThrow(
      "Timed out after 180s verifying the update's code signature",
    )
  })

  it('takes a shorter timeout for manual verification runs', async () => {
    powershell({ signature: { error: { message: 'Command failed: …', killed: true } } })

    await expect(verifyUpdateSignature(['Datawizz Inc.'], UPDATE_FILE, { timeoutMs: 300 })).rejects.toThrow(
      "Timed out after 0.3s verifying the update's code signature",
    )
    const [, , opts] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[], { timeout: number }]
    expect(opts.timeout).toBe(300)
  })

  it('rejects when PowerShell writes to stderr', async () => {
    powershell({ signature: { stderr: "The 'Get-AuthenticodeSignature' command was found in the module 'Microsoft.PowerShell.Security', but the module could not be loaded." } })

    await expect(verifyUpdateSignature(['Datawizz Inc.'], UPDATE_FILE)).rejects.toThrow(/Microsoft\.PowerShell\.Security/)
  })

  it('skips validation, like upstream, when PowerShell itself cannot run', async () => {
    powershell({
      signature: { error: { message: 'Command failed: powershell.exe' } },
      probe: { error: { message: 'Command failed: ConvertTo-Json test' } },
    })

    await expect(verifyUpdateSignature(['Datawizz Inc.'], UPDATE_FILE)).resolves.toBeNull()
  })
})
