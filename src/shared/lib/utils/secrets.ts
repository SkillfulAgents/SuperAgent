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

// Best-effort service name for a secret: "GitHub Token" -> "GitHub", "GITHUB_TOKEN" -> "Github".
export function guessSecretServiceName(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean)
  while (words.length > 1 && CREDENTIAL_WORDS.has(words[words.length - 1].toUpperCase())) words.pop()
  return words
    .map((w) => (w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(' ')
}
