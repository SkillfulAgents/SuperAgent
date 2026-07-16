import { describe, expect, it } from 'vitest'
import {
  findPotentialSecrets,
  replaceSecuredSecrets,
  type SecuredSecret,
} from './secret-detection'

describe('findPotentialSecrets', () => {
  it('detects provider-prefixed and high-entropy generic keys', () => {
    const providerKey = ['sk-', 'proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'].join('')
    const genericKey = 'bL8cN2vQ9xR4sT7uW3yZ6aD1fG5hJ8k'
    const text = `provider=${providerKey} generic=${genericKey}`

    expect(findPotentialSecrets(text).map((candidate) => candidate.value)).toEqual([
      providerKey,
      genericKey,
    ])
  })

  it('ignores prose, URLs, placeholders, and low-entropy repeated strings', () => {
    const text = [
      'characteristically is a long normal word',
      'https://example.com/documentation/getting-started',
      '[Saved key | *********]',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ].join('\n')

    expect(findPotentialSecrets(text)).toEqual([])
  })

  it('returns exact offsets for a key after a line break without swallowing punctuation', () => {
    const key = ['gh', 'p_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'].join('')
    const text = `Paste it below:\n${key}, then continue.`

    expect(findPotentialSecrets(text)).toEqual([
      {
        id: `${text.indexOf(key)}:${text.indexOf(key) + key.length}`,
        value: key,
        start: text.indexOf(key),
        end: text.indexOf(key) + key.length,
      },
    ])
  })
})

describe('replaceSecuredSecrets', () => {
  it('turns masked composer pills into agent-facing .env placeholders', () => {
    const secured: SecuredSecret[] = [
      {
        id: 'secret-1',
        key: 'GitHub Token',
        envVar: 'GITHUB_TOKEN',
        displayText: '[GitHub Token | *********]',
      },
    ]

    expect(replaceSecuredSecrets('Use [GitHub Token | *********] for this task', secured))
      .toBe('Use [Key saved to .env - GITHUB_TOKEN] for this task')
  })

  it('leaves edited or unrelated bracketed text alone', () => {
    const secured: SecuredSecret[] = [
      {
        id: 'secret-1',
        key: 'GitHub Token',
        envVar: 'GITHUB_TOKEN',
        displayText: '[GitHub Token | *********]',
      },
    ]

    expect(replaceSecuredSecrets('Use [GitHub Token | edited] and [other]', secured))
      .toBe('Use [GitHub Token | edited] and [other]')
  })
})
