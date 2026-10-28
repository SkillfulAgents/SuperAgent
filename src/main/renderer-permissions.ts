// Production loads from file:// where Chromium blocks getUserMedia by default,
// and Electron routes element.requestFullscreen() through this check too.
const ALLOWED_PERMISSIONS = new Set([
  'media',
  'mediaKeySystem',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
])

export function isAllowedRendererPermission(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission)
}
