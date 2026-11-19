import { afterEach, describe, it, expect } from 'vitest'
import { humanInputMode, noteChallenge, resetChallengedSites, siteOf, useHumanInput } from './challenge-input'

afterEach(() => resetChallengedSites())

describe('useHumanInput', () => {
  it('is on for a challenge wall and, afterwards, for the rest of that site — not for others', () => {
    expect(useHumanInput({ url: 'https://www.zillow.com/homes/', blocker: '' })).toBe(false)
    expect(useHumanInput({ url: 'https://www.zillow.com/captcha', blocker: 'PerimeterX' })).toBe(true)
    noteChallenge({ url: 'https://www.zillow.com/captcha', blocker: 'PerimeterX' })
    expect(useHumanInput({ url: 'https://zillow.com/homes/for_rent', blocker: '' })).toBe(true)
    expect(useHumanInput({ url: 'https://hotpads.com/', blocker: '' })).toBe(false)
    expect(useHumanInput(null)).toBe(false)
  })

  it('follows the override: off never, always on every click', () => {
    noteChallenge({ url: 'https://a.com/', blocker: 'Cloudflare' })
    expect(useHumanInput({ url: 'https://a.com/', blocker: 'Cloudflare' }, 'off')).toBe(false)
    expect(useHumanInput({ url: 'https://b.com/', blocker: '' }, 'always')).toBe(true)
    expect(useHumanInput(null, 'always')).toBe(true)
  })
})

describe('humanInputMode / siteOf', () => {
  it('reads the env override, defaulting to challenge', () => {
    expect(humanInputMode({})).toBe('challenge')
    expect(humanInputMode({ SUPERAGENT_BROWSER_HUMAN_INPUT: 'OFF' })).toBe('off')
    expect(humanInputMode({ SUPERAGENT_BROWSER_HUMAN_INPUT: 'always' })).toBe('always')
    expect(humanInputMode({ SUPERAGENT_BROWSER_HUMAN_INPUT: 'yes' })).toBe('challenge')
  })

  it('names a site by host without www', () => {
    expect(siteOf('https://WWW.Target.com/p/x')).toBe('target.com')
    expect(siteOf('not a url')).toBe('')
  })
})
