import { describe, expect, it } from 'vitest'
import { formatChipMarker } from '@renderer/components/messages/chip-marker'
import { findPotentialSecrets } from './secret-detection'

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

  it('does not flag a credential that was stored as a chip label', () => {
    const key = ['gh', 'p_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'].join('')
    expect(findPotentialSecrets(`Use ${formatChipMarker('secret', 'GITHUB_TOKEN', key)}`)).toEqual([])
  })

  it('still flags a credential that sits next to a chip', () => {
    const key = ['gh', 'p_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'].join('')
    const text = `${formatChipMarker('secret', 'GITHUB_TOKEN', 'GitHub Token')} ${key}`
    expect(findPotentialSecrets(text).map((candidate) => candidate.value)).toEqual([key])
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
