/**
 * Opens a popup window synchronously (to avoid browser popup blockers)
 * and returns helpers to navigate or close it.
 *
 * Must be called synchronously during a user gesture (click handler),
 * before any async work. After the async work completes, call
 * `navigate(url)` to redirect the popup to the OAuth URL.
 *
 * In Electron, no popup is opened — `navigate` uses `openExternal` instead.
 */
export function prepareOAuthPopup() {
  const popup = !window.electronAPI ? window.open('about:blank', '_blank') : null

  return {
    async navigate(url: string) {
      if (window.electronAPI) {
        await window.electronAPI.openExternal(url)
      } else if (popup) {
        popup.location.href = url
      }
    },
    close() {
      popup?.close()
    },
  }
}
