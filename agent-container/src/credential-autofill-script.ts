// Runs inside the page. Values arrive as CDP call arguments (not source text),
// and the return value intentionally contains only booleans — never a secret.
export const CREDENTIAL_AUTOFILL_FUNCTION = `function(username, password, expectedOrigin) {
  if (location.origin !== expectedOrigin) {
    return { ok: false, reason: 'origin_changed', usernameFilled: false, passwordFilled: false };
  }

  const rendered = (element) => {
    const view = element.ownerDocument.defaultView;
    if (!view) return false;
    const style = view.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
      rect.width > 0 && rect.height > 0;
  };
  const collectInputs = (root, seen = new Set()) => {
    if (!root || seen.has(root)) return [];
    seen.add(root);

    const inputs = Array.from(root.querySelectorAll('input'));
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) inputs.push(...collectInputs(element.shadowRoot, seen));
    }
    for (const frame of root.querySelectorAll('iframe, frame')) {
      try {
        // Access throws for cross-origin frames. Never weaken that browser
        // boundary: those cases fall back to an explicit user copy instead.
        if (rendered(frame) && frame.contentDocument) {
          inputs.push(...collectInputs(frame.contentDocument, seen));
        }
      } catch {
        // Cross-origin or otherwise inaccessible frame.
      }
    }
    return inputs;
  };
  const visible = (input) => {
    return !input.disabled && !input.readOnly && input.type !== 'hidden' && rendered(input);
  };
  const inputs = collectInputs(document).filter(visible);
  const passwordField = inputs.find((input) => input.type === 'password');
  if (!passwordField) {
    return { ok: false, reason: 'no_password_field', usernameFilled: false, passwordFilled: false };
  }

  const pool = inputs.filter((input) => {
    if (!['text', 'email', 'tel', 'url', ''].includes(input.type)) return false;
    const autocomplete = (input.autocomplete || '').toLowerCase();
    const identity = [input.name, input.id, input.getAttribute('aria-label'), input.placeholder]
      .filter(Boolean).join(' ').toLowerCase();
    return !autocomplete.includes('one-time-code') && !/(otp|one.?time|verification|search)/i.test(identity);
  });
  const passwordForm = passwordField.form;
  const score = (input) => {
    const autocomplete = (input.autocomplete || '').toLowerCase();
    const identity = [input.name, input.id, input.getAttribute('aria-label'), input.placeholder]
      .filter(Boolean).join(' ').toLowerCase();
    let value = 0;
    if (passwordForm && input.form === passwordForm) value += 100;
    if (input.getRootNode() === passwordField.getRootNode()) value += 50;
    if (input.ownerDocument === passwordField.ownerDocument) value += 30;
    if (autocomplete.includes('username')) value += 80;
    if (autocomplete.includes('email')) value += 70;
    if (input.type === 'email') value += 60;
    if (/(user|login|email|account)/i.test(identity)) value += 40;
    const position = input.compareDocumentPosition(passwordField);
    if (!(position & 1) && (position & 4)) value += 20;
    return value;
  };
  const usernameField = pool.sort((a, b) => score(b) - score(a))[0];

  const setValue = (input, value) => {
    const view = input.ownerDocument.defaultView;
    const inputPrototype = view.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(inputPrototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new view.Event('change', { bubbles: true, composed: true }));
  };

  let usernameFilled = false;
  if (usernameField && username) {
    setValue(usernameField, username);
    usernameFilled = true;
  }
  setValue(passwordField, password);
  passwordField.focus();
  return { ok: true, usernameFilled, passwordFilled: true };
}`;
