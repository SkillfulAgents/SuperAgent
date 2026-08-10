// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIAL_AUTOFILL_FUNCTION } from './credential-autofill-script';

type Autofill = (
  username: string,
  password: string,
  expectedOrigin: string,
) => { ok: boolean; reason?: string; usernameFilled: boolean; passwordFilled: boolean };

const autofill = (0, eval)(`(${CREDENTIAL_AUTOFILL_FUNCTION})`) as Autofill;

describe('credential autofill page function', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 200, height: 30, top: 0, right: 200, bottom: 30, left: 0,
      toJSON: () => ({}),
    });
  });

  it('fills the login fields and emits framework-compatible input events', () => {
    document.body.innerHTML = `
      <form>
        <input id="otp" name="verification-code" autocomplete="one-time-code">
        <input id="email" type="email" autocomplete="username">
        <input id="password" type="password" autocomplete="current-password">
      </form>`;
    const email = document.querySelector<HTMLInputElement>('#email')!;
    const password = document.querySelector<HTMLInputElement>('#password')!;
    const emailInput = vi.fn();
    const passwordInput = vi.fn();
    email.addEventListener('input', emailInput);
    password.addEventListener('input', passwordInput);

    expect(autofill('person@example.com', 's3cret', location.origin)).toEqual({
      ok: true,
      usernameFilled: true,
      passwordFilled: true,
    });
    expect(email.value).toBe('person@example.com');
    expect(password.value).toBe('s3cret');
    expect(document.querySelector<HTMLInputElement>('#otp')!.value).toBe('');
    expect(emailInput).toHaveBeenCalledOnce();
    expect(passwordInput).toHaveBeenCalledOnce();
  });

  it('fills login fields inside an open shadow root', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <form>
        <input id="email" type="email" autocomplete="username">
        <input id="password" type="password" autocomplete="current-password">
      </form>`;
    document.body.append(host);

    expect(autofill('person@example.com', 's3cret', location.origin)).toEqual({
      ok: true,
      usernameFilled: true,
      passwordFilled: true,
    });
    expect(shadow.querySelector<HTMLInputElement>('#email')!.value).toBe('person@example.com');
    expect(shadow.querySelector<HTMLInputElement>('#password')!.value).toBe('s3cret');
  });

  it('fills login fields inside a same-origin iframe', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    vi.spyOn(frame.contentWindow!.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 200, height: 30, top: 0, right: 200, bottom: 30, left: 0,
      toJSON: () => ({}),
    });
    frame.contentDocument!.body.innerHTML = `
      <form>
        <input id="email" type="email" autocomplete="username">
        <input id="password" type="password" autocomplete="current-password">
      </form>`;

    expect(autofill('person@example.com', 's3cret', location.origin)).toEqual({
      ok: true,
      usernameFilled: true,
      passwordFilled: true,
    });
    expect(frame.contentDocument!.querySelector<HTMLInputElement>('#email')!.value)
      .toBe('person@example.com');
    expect(frame.contentDocument!.querySelector<HTMLInputElement>('#password')!.value)
      .toBe('s3cret');
  });

  it('does not mutate the DOM when the expected origin differs', () => {
    document.body.innerHTML = '<input id="password" type="password">';
    const password = document.querySelector<HTMLInputElement>('#password')!;

    expect(autofill('', 's3cret', 'https://different.example')).toEqual({
      ok: false,
      reason: 'origin_changed',
      usernameFilled: false,
      passwordFilled: false,
    });
    expect(password.value).toBe('');
  });

  it('fails without a visible password field', () => {
    document.body.innerHTML = '<input type="email">';
    expect(autofill('person@example.com', 's3cret', location.origin)).toEqual({
      ok: false,
      reason: 'no_password_field',
      usernameFilled: false,
      passwordFilled: false,
    });
  });
});
