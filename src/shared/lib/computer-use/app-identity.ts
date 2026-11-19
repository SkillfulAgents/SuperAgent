/**
 * When two app names are one app.
 *
 * On Windows an app goes by its image name, with or without `.exe` and in any
 * case: an agent launches `notepad`, the window list says `Notepad.exe`, and
 * agent-desktop takes either. Elsewhere (macOS) a name is matched as written.
 */

/** The form two names of one app share. */
export function appKey(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? name.trim().toLowerCase().replace(/\.exe$/, '') : name
}

/** Whether two app names name the same app. */
export function sameApp(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return appKey(a, platform) === appKey(b, platform)
}
