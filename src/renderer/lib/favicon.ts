import { isElectron } from './env'

export function getWebFaviconHref(version?: string): string {
  return version ? `/api/favicon?v=${encodeURIComponent(version)}` : '/api/favicon'
}

export function applyWebFavicon(version?: string): void {
  if (typeof document === 'undefined' || isElectron()) return

  let link = document.querySelector<HTMLLinkElement>('link[data-managed-favicon="true"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    link.setAttribute('data-managed-favicon', 'true')
    document.head.appendChild(link)
  }

  link.href = getWebFaviconHref(version)
}
