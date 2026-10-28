// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MarkdownBlock } from './message-item'

// ---------------------------------------------------------------------------
// SUP-238 — agent-rendered markdown blanked tel:/sms: link hrefs.
//
// react-markdown applies `defaultUrlTransform` to every URL property; its
// safe-protocol allowlist is /^(https?|ircs?|mailto|xmpp)$/i, so any other
// scheme is rewritten to ''. tel: and sms: fell outside it, so links agents
// emitted rendered as <a href=""> — dead. https:/mailto: survived, which is
// exactly the asymmetry the tester reported.
//
// The fix is a shared `urlTransform` (markdown-url-transform.ts) that composes
// defaultUrlTransform and additionally permits the tel:/sms: composer schemes
// the Electron shell opener already allows (SUP-214 POPUP_PROTOCOLS). Genuinely
// dangerous schemes (javascript:, file:, data:, vbscript:) must STILL be blanked.
//
// This renders the real MarkdownBlock used by MessageItem, so it also guards the
// per-callsite wiring (drop the urlTransform prop and these assertions fail).
// ---------------------------------------------------------------------------

const MARKDOWN = [
  '[Website](https://www.anthropic.com)',
  '[Email](mailto:hello@example.com)',
  '[SMS](sms:+15551234567)',
  '[Phone](tel:+15551234567)',
  '[Script](javascript:steal)',
  '[Local](file:///etc/passwd)',
].join('\n\n')

const hrefOf = (linkText: string): string | null =>
  screen.getByText(linkText).getAttribute('href')

describe('SUP-238: agent markdown link scheme handling', () => {
  afterEach(cleanup)

  it('preserves https:, mailto:, tel:, and sms: hrefs', () => {
    render(<MarkdownBlock text={MARKDOWN} />)
    expect(hrefOf('Website')).toBe('https://www.anthropic.com')
    expect(hrefOf('Email')).toBe('mailto:hello@example.com')
    expect(hrefOf('SMS')).toBe('sms:+15551234567')
    expect(hrefOf('Phone')).toBe('tel:+15551234567')
  })

  it('still blanks dangerous schemes (javascript:, file:)', () => {
    render(<MarkdownBlock text={MARKDOWN} />)
    // defaultUrlTransform rewrites these to '' — the fix must not loosen that.
    expect(hrefOf('Script')).toBe('')
    expect(hrefOf('Local')).toBe('')
  })
})
