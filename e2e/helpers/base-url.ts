export function getE2EBaseUrl(defaultPort = '3000'): string {
  return process.env.E2E_BASE_URL ?? `http://localhost:${process.env.PORT ?? defaultPort}`
}

export function e2eApiUrl(path: string, defaultPort = '3000'): string {
  return new URL(path, getE2EBaseUrl(defaultPort)).toString()
}
