// Runs inside the page. Values arrive as CDP call arguments (not source text),
// and the return value intentionally contains only booleans — never a secret.
export const CREDENTIAL_AUTOFILL_FUNCTION = `function(username, password, expectedOrigin) {
  if (location.origin !== expectedOrigin) {
    return { ok: false, reason: 'origin_changed', usernameFilled: false, passwordFilled: false };
  }

  const visible = (input) => {
    const style = getComputedStyle(input);
    const rect = input.getBoundingClientRect();
    return !input.disabled && !input.readOnly && input.type !== 'hidden' &&
      style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
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
    if (autocomplete.includes('username')) value += 80;
    if (autocomplete.includes('email')) value += 70;
    if (input.type === 'email') value += 60;
    if (/(user|login|email|account)/i.test(identity)) value += 40;
    if (input.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING) value += 20;
    return value;
  };
  const usernameField = pool.sort((a, b) => score(b) - score(a))[0];

  const setValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
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
