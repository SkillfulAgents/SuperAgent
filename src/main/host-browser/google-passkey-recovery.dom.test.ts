// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://accounts.google.com/v3/signin/challenge/pk"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GOOGLE_PASSKEY_RECOVERY_EXPRESSION, isGooglePasskeyChallenge } from './google-passkey-recovery'

const challengePath = '/v3/signin/challenge/pk'
let clicked = vi.fn<() => void>()
const evaluate = () => window.eval(GOOGLE_PASSKEY_RECOVERY_EXPRESSION)

beforeEach(() => {
  history.replaceState({}, '', challengePath)
  document.body.innerHTML = '<h1>Verifying it’s you...</h1><p>Complete sign-in using your passkey</p><button>Try another way</button>'
  // jsdom has no layout/innerText. Real rendering is covered by the browser probe.
  Object.defineProperty(HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent || '' } })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 120, height: 40 } as DOMRect)
  clicked = vi.fn(() => { history.replaceState({}, '', '/v3/signin/challenge/selection') })
  document.querySelector('button')!.addEventListener('click', clicked)
})

afterEach(() => { vi.restoreAllMocks() })

describe('scoped Google fallback expression', () => {
  it('invokes the actual fallback handler and then stops matching the selection page', () => {
    expect(evaluate()).toBe('clicked')
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(location.pathname).toBe('/v3/signin/challenge/selection')
    expect(evaluate()).toBe('not-applicable')
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it.each(['/v3/signin/challenge/pwd', '/v3/signin/challenge/pk/presend', '/v3/signin/challenge/selection'])('ignores unrelated challenge %s', path => {
    history.replaceState({}, '', path)
    expect(evaluate()).toBe('not-applicable')
    expect(clicked).not.toHaveBeenCalled()
  })

  it.each(['missing progress', 'missing passkey copy', 'localized', 'multiple buttons', 'disabled', 'disabled fieldset', 'aria-disabled', 'inert', 'hidden', 'zero-size'])('fails closed when UI is uncertain: %s', variant => {
    const button = document.querySelector('button')!
    if (variant === 'missing progress') document.querySelector('h1')!.remove()
    if (variant === 'missing passkey copy') document.querySelector('p')!.remove()
    if (variant === 'localized') button.textContent = 'Andere Option wählen'
    if (variant === 'multiple buttons') document.body.append(button.cloneNode(true))
    if (variant === 'disabled') button.disabled = true
    if (variant === 'disabled fieldset') {
      const fieldset = document.createElement('fieldset')
      fieldset.disabled = true
      document.body.append(fieldset)
      fieldset.append(button)
    }
    if (variant === 'aria-disabled') button.setAttribute('aria-disabled', 'true')
    if (variant === 'inert') button.setAttribute('inert', '')
    if (variant === 'hidden') button.style.visibility = 'hidden'
    if (variant === 'zero-size') vi.mocked(button.getBoundingClientRect).mockReturnValue({ width: 0, height: 0 } as DOMRect)
    expect(evaluate()).toBe('waiting')
    expect(clicked).not.toHaveBeenCalled()
  })

  it.each([
    'https://accounts.google.com.evil.test/v3/signin/challenge/pk',
    'http://accounts.google.com/v3/signin/challenge/pk',
    'https://accounts.google.com:444/v3/signin/challenge/pk',
    'https://example.com/v3/signin/challenge/pk',
    'not a url',
  ])('rejects an unrelated origin: %s', url => {
    expect(isGooglePasskeyChallenge(url)).toBe(false)
  })

  it('checks the origin inside the browser expression too', () => {
    const run = new Function('location', 'document', `return ${GOOGLE_PASSKEY_RECOVERY_EXPRESSION}`)
    expect(run({ origin: 'https://example.com', pathname: challengePath }, document)).toBe('not-applicable')
    expect(clicked).not.toHaveBeenCalled()
  })
})
