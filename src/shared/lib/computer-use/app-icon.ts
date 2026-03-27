/**
 * App Icon Resolver
 *
 * Resolves macOS application icons to base64-encoded PNGs for display in the UI.
 * Uses osascript with JXA (JavaScript for Automation) + NSWorkspace — available
 * on all Macs without Xcode or Command Line Tools.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** In-memory cache: app name → { value, cachedAt } */
const iconCache = new Map<string, { value: string | null; cachedAt: number }>()

/** TTL for null (failed) entries — 5 minutes. Successful entries are cached indefinitely. */
const NULL_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Get a 32x32 PNG icon for a macOS app, returned as base64.
 * Results are cached in memory. Returns null if the icon can't be resolved.
 */
export async function getAppIconBase64(appName: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null

  const cached = iconCache.get(appName)
  if (cached !== undefined) {
    // Successful lookups are cached forever; failed ones expire after TTL
    if (cached.value !== null || Date.now() - cached.cachedAt < NULL_CACHE_TTL_MS) {
      return cached.value
    }
    iconCache.delete(appName)
  }

  try {
    const base64 = await resolveIcon(appName)
    iconCache.set(appName, { value: base64, cachedAt: Date.now() })
    return base64
  } catch {
    iconCache.set(appName, { value: null, cachedAt: Date.now() })
    return null
  }
}

const JXA_SCRIPT = `
ObjC.import("AppKit");
ObjC.import("Foundation");
var ws = $.NSWorkspace.sharedWorkspace;
var appPath = ws.fullPathForApplication(APPNAME);
if (!appPath || appPath.length === 0) { ""; } else {
  var icon = ws.iconForFile(appPath);
  var s = 32;
  var img = $.NSImage.alloc.initWithSize($.NSMakeSize(s,s));
  img.lockFocus;
  icon.drawInRectFromRectOperationFraction(
    $.NSMakeRect(0,0,s,s),
    $.NSMakeRect(0,0,icon.size.width,icon.size.height),
    $.NSCompositingOperationCopy, 1.0);
  img.unlockFocus;
  var tiff = img.TIFFRepresentation;
  var rep = $.NSBitmapImageRep.imageRepWithData(tiff);
  var png = rep.representationUsingTypeProperties(4, $());
  png.base64EncodedStringWithOptions(0).js;
}
`

async function resolveIcon(appName: string): Promise<string | null> {
  // Inject the app name as a JS string literal into the script
  // JSON.stringify produces a safely-escaped JS string literal (handles all unicode, quotes, etc.)
  const script = JXA_SCRIPT.replace('APPNAME', JSON.stringify(appName))

  const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], {
    timeout: 5000,
  })

  const b64 = stdout.trim()
  if (!b64 || b64.length < 20) return null
  return b64
}
