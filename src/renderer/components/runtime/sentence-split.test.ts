import { describe, it, expect } from 'vitest'
import { splitMessageSentences } from './sentence-split'

describe('splitMessageSentences', () => {
  it('splits a plain multi-sentence message one line per sentence', () => {
    expect(
      splitMessageSentences('Insufficient disk space: 5 GB required. Free up space and try again.'),
    ).toEqual([
      'Insufficient disk space: 5 GB required.',
      'Free up space and try again.',
    ])
  })

  it('keeps a single sentence on one line', () => {
    expect(splitMessageSentences('Container runtime not available.')).toEqual([
      'Container runtime not available.',
    ])
  })

  it('does not break after abbreviations followed by a capitalised word', () => {
    expect(
      splitMessageSentences('Runtime is down, e.g. Docker is not running. Open settings.'),
    ).toEqual([
      'Runtime is down, e.g. Docker is not running.',
      'Open settings.',
    ])
    expect(
      splitMessageSentences('Several runtimes work, i.e. Docker, Podman, etc. Pick one.'),
    ).toEqual(['Several runtimes work, i.e. Docker, Podman, etc. Pick one.'])
  })

  it('does not break version numbers or decimals (no space after the dot)', () => {
    expect(splitMessageSentences('Docker 4.2 needs 5.5 GB free. Update Docker.')).toEqual([
      'Docker 4.2 needs 5.5 GB free.',
      'Update Docker.',
    ])
  })

  it('does not break on a period followed by a lowercase word', () => {
    expect(splitMessageSentences('failed at step 3. retrying now')).toEqual([
      'failed at step 3. retrying now',
    ])
  })

  it('does not break after a single capitalised initial (e.g. a drive letter)', () => {
    expect(splitMessageSentences('No space on drive C. Free up space.')).toEqual([
      'No space on drive C. Free up space.',
    ])
  })

  it('handles ! and ? terminators', () => {
    expect(splitMessageSentences('Runtime crashed! Restart it. Need help?')).toEqual([
      'Runtime crashed!',
      'Restart it.',
      'Need help?',
    ])
  })

  it('returns the trimmed whole string when there is nothing to split', () => {
    expect(splitMessageSentences('  just one line  ')).toEqual(['just one line'])
  })
})
