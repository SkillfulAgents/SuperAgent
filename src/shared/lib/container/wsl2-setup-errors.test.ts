import { describe, it, expect } from 'vitest'
import {
  classifyWSL2Stderr,
  extractStderr,
  unknownRunnerSetupError,
  RunnerSetupError,
} from './wsl2-setup-errors'

// Real stderr strings from WSL — the values actually observed or documented by
// Microsoft. Keep as verbatim fixtures so regressions show up as test failures.
const FIXTURES = {
  // Rob's exact error from ELECTRON-C (virt-off + VMP-off, can't disambiguate).
  hypervNotInstalled: `WSL2 is not supported with your current machine configuration.
Please enable the "Virtual Machine Platform" optional component and ensure virtualization is enabled in the BIOS.
Enable "Virtual Machine Platform" by running: wsl.exe --install --no-distribution
For information please visit https://aka.ms/enablevirtualization
Error code: Wsl/Service/RegisterDistro/CreateVm/HCS/HCS_E_HYPERV_NOT_INSTALLED`,

  // BIOS-only: same error code but WSL only mentions firmware, no VMP hint.
  bare0x80370102: `The Virtual Machine could not be started because a required feature is not installed.
Error code: 0x80370102
Please ensure that virtualization is enabled in the BIOS firmware.`,

  // VMP missing but no HCS error code — just the install hint.
  vmpMissing: `The Windows Subsystem for Linux optional component is not enabled. Please enable it and try again.
See https://aka.ms/wslinstall for details.
To enable, run: wsl.exe --install --no-distribution`,

  // Stuck VM.
  connectionTimeout: `The operation timed out.
Error code: Wsl/Service/CreateInstance/HCS/HCS_E_CONNECTION_TIMEOUT`,

  vmInvalidState: `WSL_E_VM_MODE_INVALID_STATE`,

  // AV / permissions.
  accessDenied: `Access is denied. (0x80070005)`,

  // Missing path / broken install.
  pathNotFound: `The system cannot find the path specified.
Error: ERROR_FILE_NOT_FOUND`,

  // wsl.exe itself missing.
  wslNotInstalled: `'wsl' is not recognized as an internal or external command, operable program or batch file.`,

  // Something we don't know how to handle.
  unknown: `Some completely novel WSL failure that we haven't seen before.`,
}

describe('classifyWSL2Stderr', () => {
  it('classifies ELECTRON-C style HCS_E_HYPERV_NOT_INSTALLED as hyperv-not-installed', () => {
    const payload = classifyWSL2Stderr(FIXTURES.hypervNotInstalled)
    expect(payload).not.toBeNull()
    expect(payload!.kind).toBe('hyperv-not-installed')
    expect(payload!.userResolvable).toBe(true)
    expect(payload!.docsUrl).toBe('https://aka.ms/enablevirtualization')
    // Guidance must cover *both* VMP and BIOS since we can't disambiguate.
    expect(payload!.steps.some(s => s.command?.includes('wsl.exe --install'))).toBe(true)
    expect(payload!.steps.some(s => /bios/i.test(s.label) || /systeminfo/i.test(s.command ?? ''))).toBe(true)
    expect(payload!.originalStderr).toBe(FIXTURES.hypervNotInstalled)
  })

  it('classifies BIOS-only phrasing as virt-disabled-in-bios', () => {
    const payload = classifyWSL2Stderr(FIXTURES.bare0x80370102)
    expect(payload).not.toBeNull()
    expect(payload!.kind).toBe('virt-disabled-in-bios')
    expect(payload!.userResolvable).toBe(true)
  })

  it('classifies VMP-missing hint as vmp-feature-missing', () => {
    const payload = classifyWSL2Stderr(FIXTURES.vmpMissing)
    expect(payload).not.toBeNull()
    expect(payload!.kind).toBe('vmp-feature-missing')
    expect(payload!.steps.some(s => s.elevated)).toBe(true)
  })

  it('classifies HCS_E_CONNECTION_TIMEOUT as vm-stuck', () => {
    const payload = classifyWSL2Stderr(FIXTURES.connectionTimeout)
    expect(payload!.kind).toBe('vm-stuck')
    expect(payload!.steps.some(s => s.command === 'wsl --shutdown')).toBe(true)
  })

  it('classifies WSL_E_VM_MODE_INVALID_STATE as vm-stuck', () => {
    expect(classifyWSL2Stderr(FIXTURES.vmInvalidState)!.kind).toBe('vm-stuck')
  })

  it('classifies Access is denied as access-denied', () => {
    expect(classifyWSL2Stderr(FIXTURES.accessDenied)!.kind).toBe('access-denied')
  })

  it('classifies ERROR_FILE_NOT_FOUND as rootfs-missing', () => {
    expect(classifyWSL2Stderr(FIXTURES.pathNotFound)!.kind).toBe('rootfs-missing')
  })

  it('classifies wsl.exe-not-recognized as wsl-not-installed', () => {
    expect(classifyWSL2Stderr(FIXTURES.wslNotInstalled)!.kind).toBe('wsl-not-installed')
  })

  it('returns null for stderr that matches no known pattern', () => {
    expect(classifyWSL2Stderr(FIXTURES.unknown)).toBeNull()
    expect(classifyWSL2Stderr('')).toBeNull()
  })

  it('every known kind carries a non-empty title, remediation, and at least one step', () => {
    const all = Object.values(FIXTURES)
      .map(classifyWSL2Stderr)
      .filter((p): p is NonNullable<typeof p> => p !== null)
    expect(all.length).toBeGreaterThan(0)
    for (const payload of all) {
      expect(payload.title.length).toBeGreaterThan(0)
      expect(payload.remediation.length).toBeGreaterThan(0)
      expect(payload.steps.length).toBeGreaterThan(0)
      for (const step of payload.steps) {
        expect(step.label.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('extractStderr', () => {
  it('returns stderr from an exec-style error', () => {
    const err = { message: 'Command failed: wsl --import', stderr: 'HCS_E_HYPERV_NOT_INSTALLED\n', stdout: '' }
    expect(extractStderr(err)).toBe('HCS_E_HYPERV_NOT_INSTALLED')
  })

  it('falls back to stdout when stderr is empty', () => {
    const err = { message: 'x', stderr: '', stdout: 'some info' }
    expect(extractStderr(err)).toBe('some info')
  })

  it('falls back to message when both streams are empty', () => {
    expect(extractStderr({ message: 'bang' })).toBe('bang')
  })

  it('strips nulls from UTF-16LE-tainted strings', () => {
    // WSL often emits UTF-16LE output that leaves null bytes when decoded as utf-8.
    const err = { stderr: 'H\0C\0S\0_\0E\0' }
    expect(extractStderr(err)).toBe('HCS_E')
  })

  it('returns empty string for null/undefined', () => {
    expect(extractStderr(null)).toBe('')
    expect(extractStderr(undefined)).toBe('')
  })
})

describe('RunnerSetupError', () => {
  it('round-trips through toPayload', () => {
    const payload = classifyWSL2Stderr(FIXTURES.hypervNotInstalled)!
    const err = new RunnerSetupError(payload)
    expect(err).toBeInstanceOf(Error)
    expect(err.kind).toBe('hyperv-not-installed')
    expect(err.toPayload()).toEqual(payload)
  })

  it('uses remediation as the Error.message', () => {
    const payload = classifyWSL2Stderr(FIXTURES.vmpMissing)!
    const err = new RunnerSetupError(payload)
    expect(err.message).toBe(payload.remediation)
  })
})

describe('unknownRunnerSetupError', () => {
  it('marks unknown errors as not user-resolvable so they still go to Sentry as exceptions', () => {
    const payload = unknownRunnerSetupError('weird')
    expect(payload.kind).toBe('unknown')
    expect(payload.userResolvable).toBe(false)
    expect(payload.originalStderr).toBe('weird')
  })
})
