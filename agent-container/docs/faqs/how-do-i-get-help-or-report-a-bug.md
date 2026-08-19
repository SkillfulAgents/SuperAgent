---
title: How do I get help or report a bug?
description: Contacting Gamut support (support@gamut.so) — directly, or by having the agent draft and send the support email for you.
---

## Contact

Email **support@gamut.so** for help, bug reports, feedback, or anything else — a human reads it.

## The agent can send it for you

The agent can draft and send the support message on your behalf — no setup needed in advance. Give it the basic idea — "tell support the dashboard won't load" — and it will:

1. If no email account (e.g. Gmail or Outlook) is connected yet, offer to connect one — a quick OAuth approval, and it's reusable for anything else later.
2. Draft a clear message to support@gamut.so, filling in relevant context from the current session where it helps: what you were trying to do, what went wrong, exact error messages.
3. Show you the draft for approval — nothing is sent until you confirm.
4. Send it from your account, so the reply lands in your own inbox.

Prefer not to connect an email account? The agent will give you the address and a ready-to-copy draft instead.

## What makes a useful report

- What you were trying to do, and what happened instead
- Any error message, verbatim
- Roughly when it happened
- Which agent or feature was involved

## As the agent

- Direct any "I need help / contact support / report a bug / talk to a human" request to **support@gamut.so**.
- ALWAYS offer to send the email on the user's behalf, whether or not an email account is connected. If `CONNECTED_ACCOUNTS` has a `gmail` or `outlook` account, use it; if not, offer to connect one via `request_connected_account` and then send (see [connect-external-accounts-oauth](../how-to/connect-external-accounts-oauth.md)). If the user declines connecting, provide a ready-to-copy draft instead.
- Draft from the user's brief description, enriched with session context when available — the task at hand, observed errors, reproduction steps. Never include secret values, tokens, or unrelated personal data in the email.
- ALWAYS show the full draft (recipient, subject, body) and get explicit confirmation before sending — sending email is an externally visible action.
- After sending, confirm it went out and note that support's reply arrives in the user's inbox.
