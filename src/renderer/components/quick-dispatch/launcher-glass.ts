import {
  QUICK_DISPATCH_GLASS_MATERIAL,
  QUICK_DISPATCH_MATERIAL_PARAM,
} from '@shared/lib/quick-dispatch-glass'

let hasGlass: boolean | undefined

/**
 * True when the main process draws Liquid Glass behind this launcher window
 * (macOS 26+). It says so in the window's URL, so the answer is settled before
 * the first render and never changes for the window's life.
 */
export function launcherHasGlass(): boolean {
  hasGlass ??=
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get(QUICK_DISPATCH_MATERIAL_PARAM) === QUICK_DISPATCH_GLASS_MATERIAL
  return hasGlass
}
