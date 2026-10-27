/** A new tab version must reload both renderer caches and the browser's file bytes. */
export function withPreviewVersion(url: string, version: number): string {
  if (version <= 0) return url
  // Opaque sources (notably data: and blob:) already identify fixed bytes;
  // changing their URL would change the content or make it unreadable.
  const scheme = url.match(/^([a-z][a-z\d+.-]*):/i)?.[1].toLowerCase()
  if (scheme && scheme !== 'http' && scheme !== 'https') return url

  const hashIndex = url.indexOf('#')
  const resource = hashIndex < 0 ? url : url.slice(0, hashIndex)
  const fragment = hashIndex < 0 ? '' : url.slice(hashIndex)
  const queryIndex = resource.indexOf('?')
  const path = queryIndex < 0 ? resource : resource.slice(0, queryIndex)
  const params = new URLSearchParams(queryIndex < 0 ? '' : resource.slice(queryIndex + 1))
  params.set('v', String(version))
  return `${path}?${params}${fragment}`
}
