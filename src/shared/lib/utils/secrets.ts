// Convert a display key to an environment variable name
// e.g., "My API Key" -> "MY_API_KEY"
export function keyToEnvVar(key: string): string {
  return key
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_') // Replace non-alphanumeric with underscore
    .replace(/^_+|_+$/g, '') // Trim leading/trailing underscores
    .replace(/_+/g, '_') // Collapse multiple underscores
}
