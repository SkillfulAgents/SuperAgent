/** Open a URL in the system browser (Electron) or a new tab (web). */
export async function openExternalUrl(url: string): Promise<void> {
  if (window.electronAPI?.openExternal) {
    await window.electronAPI.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
