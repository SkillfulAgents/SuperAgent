/**
 * add_sign_in_method's browser side: read an authenticator app's setup from
 * the page — the `otpauth://` URI its QR code holds, or the key it shows to
 * type — for the host to save to the account. It goes only to the host, over
 * the host's own channel, and is redacted from everything the agent reads
 * from then on (injected-secrets). The agent never needs to open "Can't scan
 * it?": the QR code on screen is enough.
 */
import jsQR from 'jsqr'
import sharp from 'sharp'
import { isolatedWorld, type CdpConnection } from './login-cdp'
import type { LoginFillDeps } from './login-fill'

export type SetupRead =
  | { ok: true; key: string; source: 'link' | 'qr' | 'text' }
  | { ok: false; problem: string }

/** The longest page a full-page screenshot covers, in CSS pixels: setup QR codes sit near the top. */
const MAX_PAGE_HEIGHT = 6000
const MAX_PAGE_WIDTH = 2000

/** `otpauth://` URIs anywhere in the page's documents: links for phones, attributes, inputs, text. */
const OTPAUTH_IN_PAGE = String.raw`(() => {
  const found = new Set();
  const take = (value) => {
    if (typeof value !== 'string' || !/otpauth:/i.test(value)) return;
    for (const match of value.matchAll(/otpauth:\/\/[^\s"'<>]+/gi)) found.add(match[0]);
  };
  const scan = (root) => {
    for (const element of root.querySelectorAll('*')) {
      for (const attribute of element.attributes) take(attribute.value);
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) take(element.value);
      if (element.shadowRoot) scan(element.shadowRoot);
      if (element instanceof HTMLIFrameElement) {
        try { if (element.contentDocument) scan(element.contentDocument); } catch {}
      }
    }
    take(root.textContent || '');
  };
  scan(document);
  return [...found].slice(0, 5);
})()`

/**
 * Text that reads as a setup key ("JBSW Y3DP EHPK 3PXP"): one element's whole
 * text or an input's value, base32, in one case, with a digit or in groups of
 * four (a run of letters alone is likelier a word). Hidden ones count: sites
 * keep the key in the page behind "Can't scan it?".
 */
const KEYS_IN_PAGE = String.raw`(() => {
  const found = new Set();
  const consider = (raw) => {
    const text = (raw || '').trim();
    if (text.length < 16 || text.length > 200) return;
    const compact = text.replace(/[\s-]+/g, '').replace(/=+$/, '');
    const upper = compact.toUpperCase();
    if (upper.length < 16 || upper.length > 128 || !/^[A-Z2-7]+$/.test(upper)) return;
    if (compact !== upper && compact !== compact.toLowerCase()) return;
    const grouped = /^([A-Za-z2-7]{4}[\s-])+[A-Za-z2-7]{1,4}=*$/.test(text);
    if (!/[2-7]/.test(compact) && !grouped) return;
    found.add(upper);
  };
  for (const element of document.querySelectorAll('body *')) {
    if (element.children.length === 0) consider(element.textContent);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) consider(element.value);
  }
  return [...found].slice(0, 5);
})()`

async function inMainWorld(cdp: CdpConnection, expression: string): Promise<string[]> {
  const sessionId = cdp.pageSession
  const tree = await cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, sessionId)
  const contextId = await isolatedWorld(cdp, tree.frameTree.frame.id, sessionId)
  const result = await cdp.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression, contextId, returnByValue: true }, sessionId)
  const value = result.result.value
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** The text of the QR code in a PNG, or null when it holds none jsQR can read. */
export async function decodeQr(png: Buffer): Promise<string | null> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const found = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height)
  return found?.data ?? null
}

type Clip = { x: number; y: number; width: number; height: number; scale: number }

async function screenshot(cdp: CdpConnection, clip: Clip | null): Promise<Buffer> {
  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip, captureBeyondViewport: true } : {}),
  }, cdp.pageSession)
  return Buffer.from(shot.data, 'base64')
}

/** The scroll offset of the page: a box the CLI measures in the viewport is clipped in document coordinates. */
async function pageOffset(cdp: CdpConnection): Promise<{ x: number; y: number; width: number; height: number }> {
  const metrics = await cdp.send<{
    cssLayoutViewport: { pageX: number; pageY: number }
    cssContentSize: { width: number; height: number }
  }>('Page.getLayoutMetrics', {}, cdp.pageSession)
  return {
    x: metrics.cssLayoutViewport.pageX,
    y: metrics.cssLayoutViewport.pageY,
    width: metrics.cssContentSize.width,
    height: metrics.cssContentSize.height,
  }
}

const isSetupUri = (text: string | null): text is string => text !== null && /^otpauth:\/\/totp\//i.test(text.trim())

/** The `secret` an otpauth URI carries, upper case and compact, or null. */
export function otpauthSecret(uri: string): string | null {
  try {
    const secret = new URL(uri).searchParams.get('secret')
    return secret ? secret.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase() : null
  } catch {
    return null
  }
}

/**
 * Read the setup from the page: a QR code at `qrRef` when the agent names
 * one; else an `otpauth://` link in the page, the QR code in view, the one
 * further down the page, and last a lone key shown to type.
 */
export async function readAuthenticatorSetup(deps: Pick<LoginFillDeps, 'connect' | 'boxOfRef'>, options: { qrRef: string | null }): Promise<SetupRead> {
  const cdp = await deps.connect()
  try {
    if (options.qrRef) {
      const box = await deps.boxOfRef(options.qrRef)
      if (!box || box.width < 8 || box.height < 8) return { ok: false, problem: `the box of ${options.qrRef} could not be read` }
      const page = await pageOffset(cdp)
      const margin = 8
      const text = await decodeQr(await screenshot(cdp, {
        x: Math.max(0, box.x + page.x - margin),
        y: Math.max(0, box.y + page.y - margin),
        width: box.width + 2 * margin,
        height: box.height + 2 * margin,
        // Small codes read better magnified.
        scale: 2,
      }))
      if (isSetupUri(text)) return { ok: true, key: text.trim(), source: 'qr' }
      return { ok: false, problem: text === null ? `${options.qrRef} shows no QR code that could be read` : `the QR code at ${options.qrRef} does not set up an authenticator app` }
    }

    const links = await inMainWorld(cdp, OTPAUTH_IN_PAGE)
    const secrets = new Set(links.map(otpauthSecret).filter((secret) => secret !== null))
    if (links.length > 0 && secrets.size === 1) return { ok: true, key: links[0], source: 'link' }

    const inView = await decodeQr(await screenshot(cdp, null))
    if (isSetupUri(inView)) return { ok: true, key: inView.trim(), source: 'qr' }
    const page = await pageOffset(cdp)
    const whole = await decodeQr(await screenshot(cdp, {
      x: 0,
      y: 0,
      width: Math.max(1, Math.min(page.width, MAX_PAGE_WIDTH)),
      height: Math.max(1, Math.min(page.height, MAX_PAGE_HEIGHT)),
      scale: 1,
    }))
    if (isSetupUri(whole)) return { ok: true, key: whole.trim(), source: 'qr' }

    const keys = await inMainWorld(cdp, KEYS_IN_PAGE)
    if (keys.length === 1) return { ok: true, key: keys[0], source: 'text' }
    const other = [inView, whole].find((text) => text !== null)
    return {
      ok: false,
      problem: other
        ? 'the QR code on the page does not set up an authenticator app: pass the setup QR code\'s ref as qr'
        : 'no QR code or setup key for an authenticator app was found on the page: open the step that shows the QR code first',
    }
  } finally {
    cdp.close()
  }
}

/** The forms a setup key can show up in on a page and in what the agent reads: whole, grouped by four, in either case. */
export function setupKeyForms(key: string): string[] {
  const secret = /^otpauth:/i.test(key) ? otpauthSecret(key) : key.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase()
  if (!secret) return [key]
  const grouped = secret.match(/.{1,4}/g)?.join(' ') ?? secret
  const forms = new Set([key, secret, grouped, grouped.replace(/ /g, '-')])
  for (const form of [...forms]) forms.add(form.toLowerCase())
  return [...forms]
}
