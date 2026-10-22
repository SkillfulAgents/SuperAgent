import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import type { HostScriptOutput } from '@shared/lib/agent-actor/host-port'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const SCRIPT_TIMEOUT_MS = 30_000

/**
 * Run a script the user approved on this machine, with a 30-second limit. A
 * script that fails or times out still resolves: its exit code and output are
 * the result the agent reads.
 */
export async function runHostScript(script: string, scriptType: string): Promise<HostScriptOutput> {
  try {
    let result: { stdout: string; stderr: string }
    if (scriptType === 'applescript') {
      // execFile, not a shell: no escaping trouble with quotes or newlines.
      // osascript takes a multi-line script as one -e per line.
      const args = script.split('\n').filter((line) => line.trim()).flatMap((line) => ['-e', line])
      result = await execFileAsync('osascript', args, { timeout: SCRIPT_TIMEOUT_MS })
    } else if (scriptType === 'shell') {
      result = await execAsync(script, { timeout: SCRIPT_TIMEOUT_MS, shell: '/bin/zsh' })
    } else {
      // PowerShell, also through execFile.
      result = await execFileAsync('powershell.exe', ['-Command', script], { timeout: SCRIPT_TIMEOUT_MS })
    }
    return { exitCode: 0, stdout: result.stdout || '', stderr: result.stderr || '' }
  } catch (error) {
    // `code` is the exit status, or a spawn error's name (ENOENT) when the
    // interpreter itself could not run.
    const failed = error as { stdout?: string; stderr?: string; code?: number | string }
    return { exitCode: failed.code ?? 1, stdout: failed.stdout || '', stderr: failed.stderr || '' }
  }
}
