// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://accounts.google.com/v3/signin/challenge/pk"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GOOGLE_PASSKEY_INSPECTION_EXPRESSION, GOOGLE_PASSKEY_RECOVERY_EXPRESSION, isGooglePasskeyChallenge } from './google-passkey-recovery'

const challenges = [
  { challengePath: '/v3/signin/challenge/pk', credential: 'passkey' },
  { challengePath: '/v3/signin/challenge/sk/webauthn', credential: 'security key' },
]

describe.each(challenges)('scoped Google $credential fallback expression', ({ challengePath, credential }) => {
  let clicked = vi.fn<() => void>()
  const evaluate = () => window.eval(GOOGLE_PASSKEY_RECOVERY_EXPRESSION)

  beforeEach(() => {
    history.replaceState({}, '', challengePath)
    document.body.innerHTML = `<h1>Verifying it’s you...</h1><p>Complete sign-in using your ${credential}</p><button>Try another way</button>`
    // jsdom has no layout/innerText. Real rendering is covered by the browser probe.
    Object.defineProperty(HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent || '' } })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 120, height: 40 } as DOMRect)
    clicked = vi.fn(() => { history.replaceState({}, '', '/v3/signin/challenge/selection') })
    document.querySelector('button')!.addEventListener('click', clicked)
  })

  afterEach(() => { vi.restoreAllMocks() })

  it.each(['', '/', '?flow=test'])('recognizes the challenge URL with suffix "%s"', suffix => {
    expect(isGooglePasskeyChallenge(`https://accounts.google.com${challengePath}${suffix}`)).toBe(true)
    history.replaceState({}, '', `${challengePath}${suffix}`)
    expect(evaluate()).toBe('clicked')
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('invokes the actual fallback handler and then stops matching the selection page', () => {
    expect(evaluate()).toBe('clicked')
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(location.pathname).toBe('/v3/signin/challenge/selection')
    expect(evaluate()).toBe('not-applicable')
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('inspects the prompt without invoking the fallback handler', () => {
    expect(window.eval(GOOGLE_PASSKEY_INSPECTION_EXPRESSION)).toBe('ready')
    expect(clicked).not.toHaveBeenCalled()
    document.querySelector('button')!.disabled = true
    expect(window.eval(GOOGLE_PASSKEY_INSPECTION_EXPRESSION)).toBe('waiting')
    document.querySelector('h1')!.remove()
    expect(window.eval(GOOGLE_PASSKEY_INSPECTION_EXPRESSION)).toBe('cleared')
    expect(clicked).not.toHaveBeenCalled()
  })

  it.each([
    '/v3/signin/challenge/pwd',
    '/v3/signin/challenge/pk/presend',
    '/v3/signin/challenge/sk',
    '/v3/signin/challenge/sk/presend',
    '/v3/signin/challenge/sk/webauthn/presend',
    '/v3/signin/challenge/sk/webauthn-other',
    '/v3/signin/challenge/selection',
  ])('ignores unrelated challenge %s', path => {
    history.replaceState({}, '', path)
    expect(isGooglePasskeyChallenge(location.href)).toBe(false)
    expect(evaluate()).toBe('not-applicable')
    expect(clicked).not.toHaveBeenCalled()
  })

  it.each(['missing progress', 'missing credential copy', 'localized', 'multiple buttons', 'disabled', 'disabled fieldset', 'aria-disabled', 'inert', 'hidden', 'zero-size'])('fails closed when UI is uncertain: %s', variant => {
    const button = document.querySelector('button')!
    if (variant === 'missing progress') document.querySelector('h1')!.remove()
    if (variant === 'missing credential copy') document.querySelector('p')!.remove()
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
    expect(evaluate()).toBe(variant === 'missing progress' || variant === 'missing credential copy' ? 'cleared' : 'waiting')
    expect(clicked).not.toHaveBeenCalled()
  })

  it.each([
    `https://accounts.google.com.evil.test${challengePath}`,
    `http://accounts.google.com${challengePath}`,
    `https://accounts.google.com:444${challengePath}`,
    `https://example.com${challengePath}`,
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

// Sanitized structure observed on Google's live security-key challenge in
// en-US, de, and iw (RTL), 2026-09-09. No account data or hidden inputs retained.
describe('Google security-key structural recognition', () => {
  let clicked = vi.fn<() => void>()
  const evaluate = () => window.eval(GOOGLE_PASSKEY_RECOVERY_EXPRESSION)
  const render = (heading = 'מתבצע אימות של הזהות שלך...', label = 'אני רוצה לנסות דרך אחרת') => {
    document.body.innerHTML = `
      <c-wiz jscontroller="OzD1R" data-view-id="gm7v4">
        <main>
          <div jsname="rEuO1b" jscontroller="qPYxq"><span>
            <section jscontroller="Tbb4sb"><h2>${heading}</h2><div jsname="MZArnb">Localized instructions</div></section>
            <section jscontroller="Tbb4sb" jsname="INM6z" aria-hidden="true" style="display:none">Localized error</section>
            <section jscontroller="Tbb4sb" jsname="dZbRZb" style="display:none"></section>
          </span></div>
          <div jsname="DH6Rkf" jscontroller="z0u0L"><div jsname="eBSUOb" jscontroller="f8Gu1e">
            <button jsname="LgbsSe" type="button">${label}</button>
          </div></div>
          <button jsname="NakZHc" type="button">Account options</button>
        </main>
      </c-wiz>`
    document.querySelector('button')!.addEventListener('click', clicked)
  }

  beforeEach(() => {
    history.replaceState({}, '', '/v3/signin/challenge/sk/webauthn?hl=iw')
    Object.defineProperty(HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent || '' } })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 120, height: 40 } as DOMRect)
    clicked = vi.fn()
    render()
  })
  afterEach(() => { vi.restoreAllMocks(); document.documentElement.removeAttribute('dir') })

  it.each([
    ['en-US', 'ltr', 'Verifying it’s you...', 'Try another way'],
    ['de', 'ltr', 'Identität wird bestätigt…', 'Andere Option wählen'],
    ['iw', 'rtl', 'מתבצע אימות של הזהות שלך...', 'אני רוצה לנסות דרך אחרת'],
  ])('recognizes the verified structure in %s without relying on wording or direction', (locale, direction, heading, label) => {
    history.replaceState({}, '', `/v3/signin/challenge/sk/webauthn?hl=${locale}`)
    document.documentElement.dir = direction
    render(heading, label)
    expect(window.eval(GOOGLE_PASSKEY_INSPECTION_EXPRESSION)).toBe('ready')
    expect(clicked).not.toHaveBeenCalled()
    expect(evaluate()).toBe('clicked')
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it.each(['missing state', 'duplicate state', 'ambiguous views', 'ambiguous buttons', 'disabled', 'hidden parent', 'wrong footer', 'generic button only'])('does not act on uncertain structural UI: %s', variant => {
    const button = document.querySelector('button')!
    if (variant === 'missing state') document.querySelector('[jsname="dZbRZb"]')!.remove()
    if (variant === 'duplicate state') document.querySelector('[jsname="dZbRZb"]')!.setAttribute('jsname', 'INM6z')
    if (variant === 'ambiguous views') document.body.append(document.querySelector('c-wiz')!.cloneNode(true))
    if (variant === 'ambiguous buttons') button.parentElement!.append(button.cloneNode(true))
    if (variant === 'disabled') button.disabled = true
    if (variant === 'hidden parent') button.parentElement!.setAttribute('aria-hidden', 'true')
    if (variant === 'wrong footer') button.parentElement!.removeAttribute('jscontroller')
    if (variant === 'generic button only') document.querySelector('[jsname="eBSUOb"]')!.remove()
    expect(evaluate()).toBe('waiting')
    expect(clicked).not.toHaveBeenCalled()
  })

  it('recognizes the visible error state as cleared even while hidden verification copy remains', () => {
    const progress = document.querySelector('section:not([jsname])') as HTMLElement
    progress.style.display = 'none'
    const error = document.querySelector('[jsname="INM6z"]') as HTMLElement
    error.style.display = ''
    error.removeAttribute('aria-hidden')
    expect(window.eval(GOOGLE_PASSKEY_INSPECTION_EXPRESSION)).toBe('cleared')
    expect(evaluate()).toBe('cleared')
    expect(clicked).not.toHaveBeenCalled()
  })

  it('waits during an ambiguous transition with both verification and error visible', () => {
    const error = document.querySelector('[jsname="INM6z"]') as HTMLElement
    error.style.display = ''
    error.removeAttribute('aria-hidden')
    expect(evaluate()).toBe('waiting')
    expect(clicked).not.toHaveBeenCalled()
  })

  it('retains English fallback when Google changes an internal marker', () => {
    render('Verifying it’s you... Complete sign-in using your security key', 'Try another way')
    document.querySelector('[jsname="eBSUOb"]')!.removeAttribute('jsname')
    expect(evaluate()).toBe('clicked')
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('does not infer a localized passkey layout from the security-key controller', () => {
    history.replaceState({}, '', '/v3/signin/challenge/pk?hl=iw')
    expect(evaluate()).toBe('cleared')
    expect(clicked).not.toHaveBeenCalled()
  })
})
