import { CHIP_MARKER, parseChipMarker } from '@renderer/components/messages/chip-marker'

const MIN_SECRET_LENGTH = 20
const MASK = '*********'

export interface PotentialSecret {
  id: string
  value: string
  start: number
  end: number
}

const KNOWN_SECRET_PREFIX = /^(?:sk[-_]|pk[-_]|gh[pousr]_|github_pat_|xox[baprs]-|AIza|AKIA|ASIA|eyJ|SG\.|sq0atp-|npm_)/i
const HEX_SECRET = /^[a-f0-9]{32,}$/i
const TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9_+=./-]{18,}[A-Za-z0-9_+=/-]/g

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>()
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1)
  }

  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy
}

function overlaps(start: number, end: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => start < range.end && end > range.start)
}

function secretTokensIn(
  text: string,
  test: (value: string, precedingText: string) => boolean = looksLikeSecret
): Array<{ value: string; start: number }> {
  const tokens: Array<{ value: string; start: number }> = []
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    let value = match[0]
    let start = match.index
    // Assignment labels often sit directly beside the value (`token=sk-...`).
    // Keep the label out of the highlight without splitting base64 padding.
    const assignment = value.match(/^([A-Za-z_][A-Za-z0-9_-]{0,15})=(.{20,})$/)
    if (assignment) {
      start += assignment[1].length + 1
      value = assignment[2]
    }
    if (test(value, text.slice(Math.max(0, start - 3), start))) {
      tokens.push({ value, start })
    }
  }
  return tokens
}

function isCredentialShape(value: string): boolean {
  return KNOWN_SECRET_PREFIX.test(value) || HEX_SECRET.test(value)
}

function looksLikeSecret(value: string, precedingText: string): boolean {
  if (value.length < MIN_SECRET_LENGTH) return false
  if (KNOWN_SECRET_PREFIX.test(value)) return true

  const entropy = shannonEntropy(value)
  if (HEX_SECRET.test(value)) return entropy >= 2.5

  // Long URL/path segments are common in prompts and are not credentials by
  // themselves. Provider-prefixed values above still win this check.
  if (precedingText.endsWith('://') || (value.includes('/') && value.includes('.'))) return false

  const hasLower = /[a-z]/.test(value)
  const hasUpper = /[A-Z]/.test(value)
  const hasDigit = /\d/.test(value)
  const hasSymbol = /[_+=./-]/.test(value)
  if (!hasDigit || !hasLower || entropy < 3.3) return false
  if (hasUpper || hasSymbol) return true

  // Lowercase alphanumeric tokens need to be longer and more random-looking
  // to avoid flagging ordinary words with a year or version suffix.
  return value.length >= 32 && entropy >= 3.5
}

export function parseSecretMarker(raw: string): { envVar: string; key: string } | null {
  const parts = parseChipMarker(raw)
  if (!parts || parts.kind !== 'secret') return null
  if (!/^[A-Z0-9_]+$/.test(parts.referent)) return null
  if (/[\r\n]/.test(parts.label) || secretTokensIn(parts.label, isCredentialShape).length > 0) return null
  return { envVar: parts.referent, key: parts.label }
}

/**
 * Find contiguous, high-entropy words that are likely API keys or tokens.
 * Offsets are UTF-16 string offsets, matching textarea selection/range APIs.
 */
export function findPotentialSecrets(text: string): PotentialSecret[] {
  const protectedRanges: Array<{ start: number; end: number }> = []
  for (const match of text.matchAll(CHIP_MARKER)) {
    if (match.index === undefined || !parseSecretMarker(match[0])) continue
    protectedRanges.push({ start: match.index, end: match.index + match[0].length })
  }

  const candidates: PotentialSecret[] = []
  for (const token of secretTokensIn(text)) {
    const end = token.start + token.value.length
    if (overlaps(token.start, end, protectedRanges)) continue
    candidates.push({
      // IDs must never contain the credential. The range is unique within a draft.
      id: `${token.start}:${end}`,
      value: token.value,
      start: token.start,
      end,
    })
  }
  return candidates
}

export function secretDisplayText(key: string): string {
  return `[${key} | ${MASK}]`
}
