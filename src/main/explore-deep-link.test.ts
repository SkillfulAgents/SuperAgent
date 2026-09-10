import { describe, expect, it } from 'vitest'
import { isExploreDeepLink } from './explore-deep-link'

describe('isExploreDeepLink', () => {
  it('matches explore on the expected scheme', () => {
    expect(isExploreDeepLink('superagent://explore', 'superagent')).toBe(true)
    expect(isExploreDeepLink('superagent://explore/', 'superagent')).toBe(true)
    expect(isExploreDeepLink('superagent-dev://explore', 'superagent-dev')).toBe(true)
  })

  it('still matches the older open/explore form', () => {
    expect(isExploreDeepLink('superagent://open/explore', 'superagent')).toBe(true)
    expect(isExploreDeepLink('superagent://open/explore/', 'superagent')).toBe(true)
  })

  it('rejects neighboring protocol URLs', () => {
    expect(isExploreDeepLink('superagent://open', 'superagent')).toBe(false)
    expect(isExploreDeepLink('superagent://explore/extra', 'superagent')).toBe(false)
    expect(isExploreDeepLink('superagent://open/explore/extra', 'superagent')).toBe(false)
    expect(isExploreDeepLink('superagent://agent/demo', 'superagent')).toBe(false)
    expect(isExploreDeepLink('superagent://explore', 'superagent-dev')).toBe(false)
    expect(isExploreDeepLink('not a url', 'superagent')).toBe(false)
  })
})
