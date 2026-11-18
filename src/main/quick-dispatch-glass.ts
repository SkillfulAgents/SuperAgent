import { app, type BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { KoffiFunc } from 'koffi'
import { QUICK_DISPATCH_GLASS_RADIUS } from '@shared/lib/quick-dispatch-glass'

/** Built by scripts/build-spotlight-bridge.sh from native/macos/GlassBridge.swift. */
const GLASS_BRIDGE_FILE = 'libGlassBridge.dylib'

/**
 * The launcher's material: Clear Liquid Glass with a light frost tint, so the
 * panel is lighter than Regular glass but more legible than plain Clear.
 */
export const QUICK_DISPATCH_GLASS = {
  cornerRadius: QUICK_DISPATCH_GLASS_RADIUS,
  style: 1,
  tint: '#FFFFFF1A',
  tintDark: '#1C1C1E1F',
} as const

interface GlassBridge {
  apply: KoffiFunc<(view: bigint, config: string) => string | null>
}

let bridge: GlassBridge | null = null
let loading: Promise<void> | null = null

function glassBridgePath(): string {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'glass-bridge')
    : path.join(app.getAppPath(), 'build', 'glass-bridge')
  return path.join(dir, GLASS_BRIDGE_FILE)
}

/**
 * Load the glass bridge, if this Mac has Liquid Glass. Must settle before the
 * launcher window is built: glass needs a transparent window, which can only be
 * chosen at construction.
 */
export function loadQuickDispatchGlass(): Promise<void> {
  loading ??= (async () => {
    if (process.platform !== 'darwin') return
    const file = glassBridgePath()
    if (!fs.existsSync(file)) {
      if (!app.isPackaged) console.log('[QuickDispatch] Glass bridge not built; run `npm run build:spotlight-bridge` for Liquid Glass.')
      return
    }
    try {
      // Imported here: koffi throws on import where it has no native addon.
      const { load } = await import('koffi')
      const library = load(file)
      const supported = library.func('bool glass_supported()') as KoffiFunc<() => boolean>
      if (!supported()) return
      // `str!` frees the returned error string after converting it.
      bridge = { apply: library.func('str! glass_apply(uint64 view, str config)') as GlassBridge['apply'] }
    } catch (error) {
      console.error('[QuickDispatch] Failed to load the glass bridge:', error)
    }
  })()
  return loading
}

/** True once the bridge has loaded on a Mac with Liquid Glass. */
export function quickDispatchGlassAvailable(): boolean {
  return bridge !== null
}

/**
 * Put the glass behind the launcher's web content. False if it could not; it
 * never throws, since it runs while the window is being built.
 */
export function applyQuickDispatchGlass(win: BrowserWindow): boolean {
  if (!bridge) return false
  let error: string | null
  try {
    error = bridge.apply(win.getNativeWindowHandle().readBigUInt64LE(0), JSON.stringify(QUICK_DISPATCH_GLASS))
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
  }
  if (error) {
    console.error(`[QuickDispatch] Failed to apply Liquid Glass: ${error}`)
    return false
  }
  return true
}
