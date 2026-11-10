/**
 * Whether agents get computer use and host scripts: the tools that act on the
 * desktop of the host's machine. The host answers in HOST_COMPUTER_USE. A host
 * older than that answer offered both on macOS and Windows.
 */
export function isComputerUseHost(): boolean {
  const answer = process.env.HOST_COMPUTER_USE
  return answer === undefined ? ['darwin', 'win32'].includes(process.env.HOST_PLATFORM || '') : answer === 'true'
}

/** Whether the host is the Mac App Store edition, whose App Sandbox leaves out what reaches outside the app. */
export function isAppSandboxHost(): boolean {
  return process.env.HOST_APP_SANDBOX === 'true'
}
