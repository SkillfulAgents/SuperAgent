import type { WebContents } from 'electron'

// A srcdoc frame's meta CSP can't stop it loading another page (with no CSP) into itself.
export function blockSrcdocFrameNavigation(webContents: WebContents): void {
  webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame || details.frame?.url !== 'about:srcdoc' || details.url === 'about:srcdoc') return
    details.preventDefault()
  })
}
