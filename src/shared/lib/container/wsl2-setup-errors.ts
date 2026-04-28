/**
 * Classify WSL2 setup failures into actionable error kinds so the UI can
 * render a remediation panel and Sentry can bucket events by cause.
 */

export type RunnerSetupErrorKind =
  | 'virt-disabled-in-bios'
  | 'vmp-feature-missing'
  | 'hyperv-not-installed'
  | 'vm-stuck'
  | 'access-denied'
  | 'rootfs-missing'
  | 'wsl-not-installed'
  | 'unknown'

export interface RunnerSetupRemediationStep {
  label: string
  command?: string
  elevated?: boolean
}

export interface RunnerSetupRemediation {
  kind: RunnerSetupErrorKind
  title: string
  remediation: string
  steps: RunnerSetupRemediationStep[]
  docsUrl: string | null
  originalStderr: string
  /** Whether this is a user-resolvable config issue (vs. a bug in our code). */
  userResolvable: boolean
}

export class RunnerSetupError extends Error {
  readonly kind: RunnerSetupErrorKind
  readonly title: string
  readonly remediation: string
  readonly steps: RunnerSetupRemediationStep[]
  readonly docsUrl: string | null
  readonly originalStderr: string
  readonly userResolvable: boolean

  constructor(payload: RunnerSetupRemediation) {
    super(payload.remediation)
    this.name = 'RunnerSetupError'
    this.kind = payload.kind
    this.title = payload.title
    this.remediation = payload.remediation
    this.steps = payload.steps
    this.docsUrl = payload.docsUrl
    this.originalStderr = payload.originalStderr
    this.userResolvable = payload.userResolvable
  }

  toPayload(): RunnerSetupRemediation {
    return {
      kind: this.kind,
      title: this.title,
      remediation: this.remediation,
      steps: this.steps,
      docsUrl: this.docsUrl,
      originalStderr: this.originalStderr,
      userResolvable: this.userResolvable,
    }
  }
}

/**
 * Extract stderr/stdout from a failed exec error.
 */
export function extractStderr(err: unknown): string {
  if (!err || typeof err !== 'object') return ''
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string }
  const stderr = String(e.stderr ?? '').replace(/\0/g, '').trim()
  const stdout = String(e.stdout ?? '').replace(/\0/g, '').trim()
  const parts: string[] = []
  if (stderr) parts.push(stderr)
  if (stdout) parts.push(stdout)
  if (!parts.length && e.message) parts.push(e.message)
  return parts.join('\n')
}

const DOCS_ENABLE_VIRT = 'https://aka.ms/enablevirtualization'
const DOCS_WSL_INSTALL = 'https://learn.microsoft.com/en-us/windows/wsl/install'

/**
 * Map a WSL stderr string to a typed setup error. Returns null if no known
 * pattern matches — the caller should fall back to a generic unknown error.
 */
export function classifyWSL2Stderr(stderrRaw: string): RunnerSetupRemediation | null {
  const stderr = stderrRaw || ''
  const lower = stderr.toLowerCase()

  // HCS_E_HYPERV_NOT_INSTALLED: VMP feature missing OR BIOS virtualization off.
  // WSL prints a hint that tells them apart — look for explicit BIOS wording.
  if (
    lower.includes('hcs_e_hyperv_not_installed') ||
    lower.includes('0x80370102') ||
    lower.includes('virtual machine platform') ||
    lower.includes('wsl2 is not supported with your current machine configuration')
  ) {
    const mentionsBios =
      lower.includes('bios') ||
      lower.includes('firmware') ||
      lower.includes('virtualization is enabled')
    const mentionsVmp =
      lower.includes('virtual machine platform') ||
      lower.includes('wsl.exe --install --no-distribution')

    if (mentionsBios && !mentionsVmp) {
      return {
        kind: 'virt-disabled-in-bios',
        title: 'Virtualization is disabled in BIOS',
        remediation:
          'WSL2 requires hardware virtualization (Intel VT-x or AMD-V) to be enabled in your computer\'s BIOS/UEFI firmware.',
        steps: [
          { label: 'Reboot your computer and enter BIOS/UEFI setup (usually F2, F10, or Del during boot).' },
          { label: 'Find the virtualization setting, typically under "Advanced" → "CPU Configuration" (named "Intel Virtualization Technology", "VT-x", or "AMD-V").' },
          { label: 'Enable it, save, and reboot.' },
          { label: 'Verify it is enabled:', command: 'systeminfo | Select-String "Virtualization Enabled"' },
          { label: 'Then retry starting the runtime.' },
        ],
        docsUrl: DOCS_ENABLE_VIRT,
        originalStderr: stderr,
        userResolvable: true,
      }
    }

    // Default for HCS_E_HYPERV_NOT_INSTALLED: could be either — guide through both.
    return {
      kind: 'hyperv-not-installed',
      title: 'WSL2 virtualization is not available',
      remediation:
        'Windows reports that the Hyper-V platform is not installed. This usually means either the "Virtual Machine Platform" Windows feature is off, or hardware virtualization is disabled in your BIOS.',
      steps: [
        { label: 'Enable the Virtual Machine Platform feature (requires administrator):', command: 'wsl.exe --install --no-distribution', elevated: true },
        { label: 'Reboot your computer.' },
        { label: 'If the error persists after reboot, check that virtualization is enabled in BIOS:', command: 'systeminfo | Select-String "Virtualization Enabled"' },
        { label: 'If "Virtualization Enabled In Firmware" shows No, enter BIOS/UEFI setup and enable Intel VT-x / AMD-V.' },
        { label: 'Then retry starting the runtime.' },
      ],
      docsUrl: DOCS_ENABLE_VIRT,
      originalStderr: stderr,
      userResolvable: true,
    }
  }

  // VMP feature missing but error code didn't show — detect from the install hint.
  if (lower.includes('wsl.exe --install') && lower.includes('--no-distribution')) {
    return {
      kind: 'vmp-feature-missing',
      title: 'Virtual Machine Platform is not enabled',
      remediation:
        'The "Virtual Machine Platform" Windows feature is required for WSL2. Enable it, then reboot.',
      steps: [
        { label: 'Open PowerShell as administrator.' },
        { label: 'Run:', command: 'wsl.exe --install --no-distribution', elevated: true },
        { label: 'Reboot your computer.' },
        { label: 'Retry starting the runtime.' },
      ],
      docsUrl: DOCS_WSL_INSTALL,
      originalStderr: stderr,
      userResolvable: true,
    }
  }

  // Stuck VM / connection timeout — usually fixed by `wsl --shutdown`.
  if (
    lower.includes('hcs_e_connection_timeout') ||
    lower.includes('wsl_e_vm_mode_invalid_state') ||
    lower.includes('the virtual machine could not be started')
  ) {
    return {
      kind: 'vm-stuck',
      title: 'WSL2 virtual machine is stuck',
      remediation:
        'The WSL2 VM did not respond. This is usually fixed by shutting down WSL and retrying.',
      steps: [
        { label: 'Shut down WSL:', command: 'wsl --shutdown' },
        { label: 'Retry starting the runtime.' },
        { label: 'If the error persists, reboot your computer.' },
      ],
      docsUrl: null,
      originalStderr: stderr,
      userResolvable: true,
    }
  }

  // AV / Controlled Folder Access blocking writes.
  if (
    lower.includes('access is denied') ||
    lower.includes('0x80070005') ||
    lower.includes('eacces') ||
    lower.includes('permission denied')
  ) {
    return {
      kind: 'access-denied',
      title: 'Access denied while creating WSL2 distro',
      remediation:
        'Windows blocked writing to the Superagent data directory. This is usually caused by antivirus software or Windows Controlled Folder Access.',
      steps: [
        { label: 'Open Windows Security → Virus & threat protection → Ransomware protection → Manage Controlled folder access.' },
        { label: 'Allow Superagent through Controlled Folder Access, or temporarily disable it to confirm it is the cause.' },
        { label: 'Whitelist the Superagent data folder in your antivirus: %APPDATA%\\superagent' },
        { label: 'Retry starting the runtime.' },
      ],
      docsUrl: null,
      originalStderr: stderr,
      userResolvable: true,
    }
  }

  // Missing rootfs — either a broken install or WSL couldn't read the path.
  if (
    lower.includes('the system cannot find the path') ||
    lower.includes('error_file_not_found') ||
    lower.includes('no such file or directory')
  ) {
    return {
      kind: 'rootfs-missing',
      title: 'WSL2 could not read the Alpine rootfs',
      remediation:
        'Windows reported that the path to the bundled Alpine rootfs could not be found. Your Superagent install may be corrupt, or %APPDATA% may be redirected to OneDrive.',
      steps: [
        { label: 'Check whether your AppData is redirected to OneDrive:', command: '[Environment]::GetFolderPath("ApplicationData")' },
        { label: 'If the path is inside OneDrive, pause OneDrive sync and retry.' },
        { label: 'Otherwise, reinstall Superagent to restore the bundled Alpine rootfs.' },
      ],
      docsUrl: null,
      originalStderr: stderr,
      userResolvable: true,
    }
  }

  // wsl.exe itself missing.
  if (
    lower.includes("'wsl' is not recognized") ||
    lower.includes('is not recognized as an internal or external command')
  ) {
    return {
      kind: 'wsl-not-installed',
      title: 'WSL is not installed',
      remediation:
        'Windows Subsystem for Linux is not installed on this machine.',
      steps: [
        { label: 'Open PowerShell as administrator and run:', command: 'wsl.exe --install', elevated: true },
        { label: 'Reboot your computer.' },
        { label: 'Retry starting the runtime.' },
      ],
      docsUrl: DOCS_WSL_INSTALL,
      originalStderr: stderr,
      userResolvable: true,
    }
  }

  return null
}

/** Build an "unknown" payload when stderr didn't match any known pattern. */
export function unknownRunnerSetupError(stderr: string): RunnerSetupRemediation {
  return {
    kind: 'unknown',
    title: 'Failed to set up WSL2 runtime',
    remediation:
      'An unexpected error occurred while setting up the WSL2 runtime. The error details have been reported to Superagent.',
    steps: [
      { label: 'Try shutting down WSL and retrying:', command: 'wsl --shutdown' },
      { label: 'If the error persists, reboot your computer.' },
      { label: 'Check that WSL is up to date:', command: 'wsl --update' },
    ],
    docsUrl: null,
    originalStderr: stderr,
    userResolvable: false,
  }
}
