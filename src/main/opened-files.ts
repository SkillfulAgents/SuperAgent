import path from 'path'

export interface CommandLineFileOpts {
  platform: NodeJS.Platform
  isPackaged: boolean
  protocolScheme: string
  workingDirectory: string
  /** True if the resolved absolute path exists and is a regular file. */
  fileExists: (absPath: string) => boolean
}

/**
 * Extract real file paths from a process command line — the Windows/Linux
 * counterpart to macOS's `open-file` event. "Open With", dragging a file onto
 * the executable / a shortcut, and CLI file args all arrive as argv there.
 *
 * Returns [] on macOS (which uses `open-file` instead) and in unpackaged/dev
 * builds, where argv carries the Electron entry script and Chromium switches
 * that would masquerade as file paths.
 */
export function filesFromCommandLine(commandLine: string[], opts: CommandLineFileOpts): string[] {
  if (opts.platform === 'darwin' || !opts.isPackaged) return []
  const files: string[] = []
  // slice(1): argv[0] is the executable itself, never a document to attach.
  for (const arg of commandLine.slice(1)) {
    if (!arg || arg.startsWith('-')) continue // Electron/Chromium switches
    if (arg.startsWith(`${opts.protocolScheme}://`)) continue // deep-link URL (handled elsewhere)
    const resolved = path.isAbsolute(arg) ? arg : path.resolve(opts.workingDirectory, arg)
    if (opts.fileExists(resolved)) files.push(resolved)
  }
  return files
}
