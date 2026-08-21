import { powerSaveBlocker, dialog } from 'electron'
import { exec, execFile, execFileSync } from 'child_process'
import fs from 'fs'
import { runWithAdminPrivileges } from '@shared/lib/run-with-admin-privileges'

let powerSaveBlockerId: number | null = null
let disableSleepActive = false
let operationInProgress: Promise<void> | null = null

const SUDOERS_PATH = '/etc/sudoers.d/superagent-pmset'
const SUDOERS_RULE =
  '%admin ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1'

function hasSudoersRule(): boolean {
  try {
    if (!fs.existsSync(SUDOERS_PATH)) return false
    const stat = fs.statSync(SUDOERS_PATH)
    return (stat.mode & 0o777) === 0o440
  } catch {
    return false
  }
}

function runPmsetSudo(flag: '0' | '1'): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['/usr/bin/pmset', '-a', 'disablesleep', flag], (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function installSudoersRule(): Promise<void> {
  if (hasSudoersRule()) return
  const cmd = [
    `printf '%s\\n' '${SUDOERS_RULE}' > /tmp/superagent-pmset`,
    'visudo -cf /tmp/superagent-pmset',
    `mv /tmp/superagent-pmset ${SUDOERS_PATH}`,
    `chmod 0440 ${SUDOERS_PATH}`,
    `chown root:wheel ${SUDOERS_PATH}`,
  ].join(' && ')
  await runWithAdminPrivileges(cmd)
}

async function runPmset(flag: '0' | '1'): Promise<void> {
  if (!hasSudoersRule()) {
    await installSudoersRule()
  }
  await runPmsetSudo(flag)
}

function isDisableSleepOn(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('pmset -g | grep -i disablesleep', (error, stdout) => {
      if (error) {
        resolve(false)
        return
      }
      resolve(/disablesleep\s+1/i.test(stdout))
    })
  })
}

async function doEnable(): Promise<void> {
  if (powerSaveBlockerId === null) {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  }

  if (process.platform === 'darwin') {
    try {
      await runPmset('1')
      disableSleepActive = true
    } catch (error) {
      if (powerSaveBlockerId !== null) {
        powerSaveBlocker.stop(powerSaveBlockerId)
        powerSaveBlockerId = null
      }
      throw error
    }
  }
}

async function doDisable(): Promise<void> {
  if (powerSaveBlockerId !== null) {
    powerSaveBlocker.stop(powerSaveBlockerId)
    powerSaveBlockerId = null
  }

  if (process.platform === 'darwin' && disableSleepActive) {
    await runPmset('0')
    disableSleepActive = false
  }
}

function withMutex(fn: () => Promise<void>): Promise<void> {
  const next = (operationInProgress ?? Promise.resolve()).then(fn, fn)
  operationInProgress = next
  return next
}

export function enableKeepAwake(): Promise<void> {
  return withMutex(doEnable)
}

export function disableKeepAwake(): Promise<void> {
  return withMutex(doDisable)
}

export function cleanupKeepAwake(): void {
  if (powerSaveBlockerId !== null) {
    powerSaveBlocker.stop(powerSaveBlockerId)
    powerSaveBlockerId = null
  }

  if (disableSleepActive && process.platform === 'darwin' && hasSudoersRule()) {
    try {
      execFileSync('sudo', ['/usr/bin/pmset', '-a', 'disablesleep', '0'], { timeout: 5000 })
    } catch {
      // Best effort — process is exiting
    }
    disableSleepActive = false
  }
}

export async function restoreKeepAwakeOnStartup(enabled: boolean): Promise<void> {
  if (process.platform !== 'darwin') return

  const stale = await isDisableSleepOn()

  if (enabled) {
    if (powerSaveBlockerId === null) {
      powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    }
    if (!stale) {
      try {
        await runPmset('1')
        disableSleepActive = true
      } catch {
        // User cancelled sudo — keep-awake will be partial (App Nap only)
      }
    } else {
      disableSleepActive = true
    }
  } else if (stale) {
    if (hasSudoersRule()) {
      try {
        await runPmsetSudo('0')
      } catch {
        // sudoers rule exists but failed — fall through to dialog
      }
      return
    }
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Keep Awake Cleanup',
      message: 'Gamut previously prevented your Mac from sleeping, but that setting is still active from a prior session. Would you like to restore normal sleep behavior?',
      buttons: ['Restore Sleep', 'Leave As-Is'],
      defaultId: 0,
    })
    if (response === 0) {
      try {
        await runPmset('0')
      } catch {
        // User cancelled sudo — leave as-is
      }
    }
  }
}
