// Convert a display key to an environment variable name
// e.g., "My API Key" -> "MY_API_KEY"
export function keyToEnvVar(key: string): string {
  return key
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_') // Replace non-alphanumeric with underscore
    .replace(/^_+|_+$/g, '') // Trim leading/trailing underscores
    .replace(/_+/g, '_') // Collapse multiple underscores
}

const CREDENTIAL_WORDS = new Set([
  'API', 'ACCESS', 'AUTH', 'BOT', 'CLIENT', 'KEY', 'PASSWORD', 'PAT', 'PERSONAL', 'PRIVATE', 'SECRET', 'TOKEN',
])

// Best-effort service name for a secret, e.g. "GITHUB_TOKEN" -> "Github"; the user can correct it.
export function guessSecretServiceName(envVar: string): string {
  const words = envVar.split('_').filter(Boolean)
  while (words.length > 1 && CREDENTIAL_WORDS.has(words[words.length - 1])) words.pop()
  return words.map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')
}
