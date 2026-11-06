import { describe, expect, it } from 'vitest'
import { browserScale, pinBrowserScaleArgs } from './browser-scale'

describe('browser scale', () => {
  it('leaves Chrome at its default unless asked', () => {
    const env = { AGENT_BROWSER_ARGS: '--no-sandbox' }
    pinBrowserScaleArgs(env)
    expect(browserScale(env)).toBeUndefined()
    expect(env.AGENT_BROWSER_ARGS).toBe('--no-sandbox')
  })

  it('adds the screen to the args every agent-browser call inherits when asked', () => {
    const env = { BROWSER_HIGH_DPI: '1', AGENT_BROWSER_ARGS: '--no-sandbox' }
    pinBrowserScaleArgs(env)
    expect(browserScale(env)).toBe(2)
    expect(env.AGENT_BROWSER_ARGS).toBe('--no-sandbox,--screen-info={2560x1440 devicePixelRatio=2}')
  })
})
