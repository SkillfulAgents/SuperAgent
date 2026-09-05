function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Match the storage name returned for an uploaded file. */
export function timestampedUploadNamePattern(fileName: string): RegExp {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return new RegExp(`${escapeRegExp(fileName)}-\\d{13}`)

  const stem = fileName.slice(0, dot)
  const extension = fileName.slice(dot)
  return new RegExp(`${escapeRegExp(stem)}-\\d{13}${escapeRegExp(extension)}`)
}
