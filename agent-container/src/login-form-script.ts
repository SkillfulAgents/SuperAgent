// Page functions for request_login. They run in an isolated world of the
// frame that holds the field, so page scripts cannot patch the value setter
// or `location` they rely on. Values arrive as CDP call arguments (never as
// source text), and nothing they return contains a value.

/** The kinds of field a sign-in form can ask for. */
export const LOGIN_FIELD_KINDS = ['username', 'password', 'otp', 'text'] as const
export type LoginFieldKind = (typeof LOGIN_FIELD_KINDS)[number]

/**
 * Kinds whose values are redacted from what the agent reads. Only the
 * account identifier stays visible (the agent needs to know who it signed in
 * as); `text` is redacted too, since its label is the agent's to choose.
 */
export const SECRET_LOGIN_FIELD_KINDS: ReadonlySet<LoginFieldKind> = new Set(['password', 'otp', 'text'])

/**
 * The input types each kind may be written into. A password only ever goes
 * into a password field; a username never does.
 */
export const LOGIN_FIELD_INPUT_TYPES: Record<LoginFieldKind, readonly string[]> = {
  username: ['text', 'email', 'tel', 'url'],
  password: ['password'],
  otp: ['text', 'tel', 'number', 'password'],
  text: ['text', 'email', 'tel', 'url', 'number', 'search', 'textarea'],
}

export interface FieldBox {
  x: number
  y: number
  width: number
  height: number
}

/** What the page says about the element that has focus in one frame. */
export interface FocusedElementDescription {
  tag: string
  /** Lowercased input type, 'textarea', or '' for any other element. */
  type: string
  isFrame: boolean
  origin: string
  url: string
  box: FieldBox
  rendered: boolean
  disabled: boolean
  readOnly: boolean
  inputMode: string
  autocomplete: string
  maxLength: number
  /** The element's document is a page of the app itself (it carries the app's marker). */
  appPage: boolean
}

/** The meta tag the app's own pages carry (src/renderer/index.html). */
export const APP_PAGE_MARKER = 'meta[name="superagent-app"]'

export type WriteFieldReason =
  | 'origin_changed'
  | 'detached'
  | 'wrong_type'
  | 'not_editable'
  | 'not_visible'
  | 'not_the_field'
  | 'otp_boxes'

export type WriteFieldResult =
  | { ok: true; kept: boolean; boxes?: number; pageValue?: string }
  | { ok: false; reason: WriteFieldReason; origin?: string; type?: string }

/**
 * A written field just before the submit: still holding its value, holding
 * another, no longer in its document, or disabled or made read-only since
 * the write (the page is busy with it).
 */
export type HeldState = 'held' | 'differs' | 'detached' | 'locked'

/** The page around the last field written, as the fill's own world sees it. */
export interface FillPageState {
  /** A submit event fired in the field's document or shadow root since this fill's first write. */
  submitted: boolean
  connected: boolean
  origin: string
}

/**
 * The element that has focus in this frame, through open shadow roots, or
 * null when nothing does. Evaluated as an expression.
 */
export const DEEP_ACTIVE_ELEMENT_EXPRESSION = `(() => {
  let element = document.activeElement;
  while (element && element.shadowRoot && element.shadowRoot.activeElement) {
    element = element.shadowRoot.activeElement;
  }
  if (!element || element === document.body || element === document.documentElement) return null;
  return element;
})()`

/** Describe `this` (an element). Returns no values. */
export const DESCRIBE_ELEMENT_FUNCTION = `function () {
  const element = this;
  const view = element.ownerDocument.defaultView;
  const tag = element.tagName.toLowerCase();
  const type = tag === 'input' ? (element.type || 'text').toLowerCase() : tag === 'textarea' ? 'textarea' : '';
  const rect = element.getBoundingClientRect();
  const style = view.getComputedStyle(element);
  return {
    tag,
    type,
    isFrame: tag === 'iframe' || tag === 'frame',
    origin: location.origin,
    url: location.href,
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    rendered: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
    disabled: element.matches(':disabled'),
    readOnly: !!element.readOnly,
    inputMode: (element.getAttribute('inputmode') || '').toLowerCase().slice(0, 32),
    autocomplete: (element.getAttribute('autocomplete') || '').toLowerCase().slice(0, 100),
    maxLength: typeof element.maxLength === 'number' ? element.maxLength : -1,
    appPage: !!element.ownerDocument.querySelector('${APP_PAGE_MARKER}'),
  };
}`

/**
 * Page-side helpers shared by the write and the read-back, so both pick the
 * same split code boxes. Inlined into each function (they run in the page).
 */
const FIELD_HELPERS = `
  const typeOf = (node) => node.tagName.toLowerCase() === 'input'
    ? (node.type || 'text').toLowerCase()
    : node.tagName.toLowerCase() === 'textarea' ? 'textarea' : '';
  const editable = (node) => !node.matches(':disabled') && !node.readOnly;
  const rendered = (node) => {
    const rect = node.getBoundingClientRect();
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  // The run of visible inputs of an allowed type that pass \`test\`, from this
  // one on, in the nearest ancestor that holds enough of them.
  const inputRun = (element, count, allowedTypes, test) => {
    let scope = element.parentElement;
    for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
      const all = Array.from(scope.querySelectorAll('input')).filter((node) =>
        allowedTypes.includes(typeOf(node)) && rendered(node) && test(node));
      const start = all.indexOf(element);
      if (start >= 0 && all.length - start >= count) return all.slice(start, start + count);
    }
    return [];
  };
  // Split code boxes to type into: editable one-character boxes.
  const codeBoxes = (element, count, allowedTypes) =>
    inputRun(element, count, allowedTypes, (node) => node.maxLength === 1 && editable(node));
  // The boxes a page spread a whole code over from the box it went into
  // (a box that takes a pasted code and hands one character to each).
  const spreadBoxes = (element, value, allowedTypes) => {
    const run = inputRun(element, value.length, allowedTypes, () => true);
    return run.length === value.length && run.map((node) => node.value).join('') === value ? run : null;
  };
`

/**
 * Write `value` into `this` (the focused field). The origin check, the
 * identity and type checks and the write happen in this one task, so a page
 * that navigated or swapped the field since it was located gets nothing.
 *
 * A one-time code longer than one character, aimed at a box that takes one
 * character, is typed across the run of such boxes that starts there.
 *
 * Before writing, it starts watching the document (and the field's shadow
 * root, which a form's submit event does not leave) for a form submission (a
 * code field that submits on its last digit), which the submit step reads
 * back from this world. It records the nodes it typed into, for the
 * read-back and the Enter check, and masks a secret written into a visible
 * text input, so a screenshot does not show it. A value the page rewrote is
 * returned for the caller to redact — `secret` says whether it may be; the
 * caller never reports it.
 */
export const WRITE_FIELD_FUNCTION = `function (value, expectedOrigin, kind, allowedTypes, expectedBox, secret, fillId) {
  if (location.origin !== expectedOrigin) return { ok: false, reason: 'origin_changed', origin: location.origin };
  const element = this;
  if (!element.isConnected) return { ok: false, reason: 'detached' };
  ${FIELD_HELPERS}
  const view = element.ownerDocument.defaultView;
  const tag = element.tagName.toLowerCase();
  const type = typeOf(element);
  if (!allowedTypes.includes(type)) return { ok: false, reason: 'wrong_type', type };
  if (!editable(element)) return { ok: false, reason: 'not_editable' };
  if (!rendered(element)) return { ok: false, reason: 'not_visible' };
  if (expectedBox) {
    const rect = element.getBoundingClientRect();
    const off = Math.max(
      Math.abs(rect.x - expectedBox.x),
      Math.abs(rect.y - expectedBox.y),
      Math.abs(rect.width - expectedBox.width),
      Math.abs(rect.height - expectedBox.height),
    );
    if (off > 2) return { ok: false, reason: 'not_the_field' };
  }

  // One watcher per document and shadow root; its record belongs to the
  // current fill, so a submit from an earlier attempt on the same page does
  // not count.
  const watched = globalThis.__superagentLoginWatched || (globalThis.__superagentLoginWatched = new WeakSet());
  for (const root of [element.ownerDocument, element.getRootNode()]) {
    if (watched.has(root)) continue;
    watched.add(root);
    root.addEventListener('submit', () => {
      if (globalThis.__superagentLoginWatch) globalThis.__superagentLoginWatch.submitted = true;
    }, true);
  }
  if (!globalThis.__superagentLoginWatch || globalThis.__superagentLoginWatch.fillId !== fillId) {
    globalThis.__superagentLoginWatch = { fillId, submitted: false };
  }
  const typedNodes = globalThis.__superagentTyped || (globalThis.__superagentTyped = new WeakMap());
  const mask = (node) => {
    if (secret && typeOf(node) !== 'password') node.style.setProperty('-webkit-text-security', 'disc', 'important');
  };

  const prototype = tag === 'textarea' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
  const put = (node, text) => {
    setter.call(node, text);
    node.dispatchEvent(new view.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText' }));
    node.dispatchEvent(new view.Event('change', { bubbles: true, composed: true }));
    // Widgets that enable their submit button on a key release.
    node.dispatchEvent(new view.KeyboardEvent('keyup', { bubbles: true, composed: true, key: 'Unidentified' }));
  };

  if (kind === 'otp' && value.length > 1 && element.maxLength === 1) {
    const boxes = codeBoxes(element, value.length, allowedTypes);
    if (boxes.length !== value.length) return { ok: false, reason: 'otp_boxes' };
    boxes.forEach((box, index) => {
      box.focus();
      put(box, value[index]);
      mask(box);
    });
    typedNodes.set(element, boxes);
    const typed = boxes.map((box) => box.value).join('');
    return typed === value
      ? { ok: true, kept: true, boxes: boxes.length }
      : { ok: true, kept: false, boxes: boxes.length, ...(secret ? { pageValue: typed } : {}) };
  }

  put(element, value);
  if (element.value !== value && kind === 'otp' && value.length > 1) {
    const spread = spreadBoxes(element, value, allowedTypes);
    if (spread) {
      spread.forEach(mask);
      typedNodes.set(element, spread);
      return { ok: true, kept: true, boxes: spread.length };
    }
  }
  mask(element);
  typedNodes.set(element, [element]);
  return element.value === value
    ? { ok: true, kept: true }
    : { ok: true, kept: false, ...(secret ? { pageValue: element.value } : {}) };
}`

/**
 * What became of a written field just before the submit, read from the very
 * nodes the write typed into (a field's split code boxes included): 'held',
 * 'differs', 'detached' (no longer in the document), or 'locked' (disabled
 * or read-only since the write: the page is busy with it). A code the page
 * has spread over the boxes after the one it went into since the write
 * counts as held there, and those boxes are masked like typed ones.
 */
export const HOLDS_VALUE_FUNCTION = `function (value, kind, allowedTypes) {
  ${FIELD_HELPERS}
  const typedNodes = globalThis.__superagentTyped || (globalThis.__superagentTyped = new WeakMap());
  let typed = typedNodes.get(this) || [this];
  if (typed.some((node) => !node.isConnected)) return 'detached';
  if (typed.length === 1 && kind === 'otp' && value.length > 1 && this.value !== value) {
    const spread = spreadBoxes(this, value, allowedTypes);
    if (spread) {
      typed = spread;
      typedNodes.set(this, spread);
      for (const node of spread) {
        if (typeOf(node) !== 'password') node.style.setProperty('-webkit-text-security', 'disc', 'important');
      }
    }
  }
  if (typed.map((node) => node.value).join('') !== value) return 'differs';
  if (typed.some((node) => node.matches(':disabled') || node.readOnly)) return 'locked';
  return 'held';
}`

/**
 * The page around the last field written: whether a submit event fired since
 * this fill started (a code field that submits on its last character),
 * whether the field is still in its document, and the frame's origin.
 */
export const FILL_PAGE_STATE_FUNCTION = `function (fillId) {
  const watch = globalThis.__superagentLoginWatch;
  return {
    submitted: !!(watch && watch.fillId === fillId && watch.submitted),
    connected: this.isConnected,
    origin: location.origin,
  };
}`

/**
 * Click `this` (the submit control) from the page, after checking the frame
 * is still on the expected origin — for a button a banner covers, where the
 * CLI's click refuses rather than land on the banner.
 */
export const CLICK_IN_PAGE_FUNCTION = `function (expectedOrigin) {
  if (location.origin !== expectedOrigin) return 'origin_changed';
  if (!this.isConnected) return 'detached';
  this.click();
  return 'clicked';
}`

/**
 * Whether focus is still in `this` (the last field written) — or in one of
 * the code boxes the write typed across — on the expected origin: Enter
 * would land in it.
 */
export const STILL_FOCUSED_FUNCTION = `function (expectedOrigin) {
  if (location.origin !== expectedOrigin || !this.isConnected) return false;
  const typed = (globalThis.__superagentTyped && globalThis.__superagentTyped.get(this)) || [this];
  let active = this.ownerDocument.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  return typed.includes(active);
}`
