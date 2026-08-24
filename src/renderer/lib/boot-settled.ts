// Latched once a boot resolves with no wizard: setupCompleted only reverts on
// factory reset, so later boots can release the outlet gate synchronously.
const BOOT_SETTLED_KEY = 'superagent-boot-settled'

export function hasBootSettledLatch(): boolean {
  return window.localStorage.getItem(BOOT_SETTLED_KEY) === 'true'
}

export function setBootSettledLatch(): void {
  window.localStorage.setItem(BOOT_SETTLED_KEY, 'true')
}

export function clearBootSettledLatch(): void {
  window.localStorage.removeItem(BOOT_SETTLED_KEY)
}
