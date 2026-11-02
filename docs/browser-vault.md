# Browser Vault

Agents sign in to websites without credentials passing through the model.
Part 1 (request_login) gave the agent a tool that maps a page's sign-in fields
by ref while the user types the values into a form in the app; the container
writes them into the page over CDP. Part 2 adds the vault: accounts the user
saved, filled by the host on the agent's request, step by step, only for the
agents the user granted them to.

Code: `src/shared/lib/browser-vault/` (host), `agent-container/src/login-*.ts`
and `agent-container/src/tools/request-login.ts` (container),
`src/shared/lib/tools/request-login/` (the card), Settings → Logins
(`src/renderer/components/settings/logins-tab.tsx`).

## Accounts

An account is an owner's identity on a site: `(owner, site, username)` is
unique (`browser_accounts`). The site is the exact host of the frame holding
the fields, port included, without a leading `www.` (`siteOfOrigin`):
accounts match on it as browsers fill saved passwords. A registrable domain
would make tenants of a shared host one site — `acme.okta.com` and
`evil.okta.com`, `*.slack.com`, `*.zendesk.com`, none of them on the Public
Suffix List — and fill one tenant's password into another's page. The
registrable domain (`registrableDomain`) only tells which sign-in provider a
site belongs to (`providerOf`: accounts.google.com is Google's). Usernames
compare without case or surrounding space.

Each sign-in step adds parts to the same account: `password`, or
`text:<label>` for another field the site asks for (a workspace). Parts are
sealed together in `secrets` (AES-256-GCM, bound to the row's id, site and
purpose); `parts` lists their names in plain text for the UI and the agent. A
one-time code is never a part. The key is the vault's own: 32 random bytes in
`<data dir>/.vault-key` (owner-only), made on first use with an exclusive
create, so two processes starting at once keep one key. It is not the auth
secret: setting, rotating or resetting that never locks the vault. Restoring
the database with that file opens the vault; a file that holds no key is never
written over. An account sealed under another key fills nothing (the user is
asked), and is saved over only with every part it lists, never by dropping the
rest. On desktop, Electron's `safeStorage` (Keychain, DPAPI, libsecret) can
hold the key later: a migration only re-stores the same key.

An account that signs in through another one ("Continue with Google") points
at the provider's account with `via_account_id`. Granting the site's account
does not grant the provider's: that one opens far more than the site. Picking
a provider for an account that had a password drops the password
(`switchAccountToVia`): the vault would otherwise keep filling it. A provider
account named in the card ("me@gmail.com at Google") is saved on the
provider's domain with no value; its password, once typed on the provider's
sign-in site, lands in that same account (`providerStub`).

Grants (`agent_browser_accounts`) decide which agents may use an account; they
go with the agent (foreign key) and with the account. Every use is in the
audit log (`browser_account` / `used`), never the values.

## A request_login call

The host decides each call before any card shows (`decideLoginRequest`,
reached from the actor's tool-call handling through the host port), so a
sign-in the vault can do never notifies anyone:

1. Without `username`: the agent's accounts on the site are listed and nothing
   is filled. With none, the card opens (`vault.mode = 'new'`).
2. With `username`: that account's parts fill the mapped fields through the
   container's fill endpoint, and the page is submitted. What the account
   lacks (a code, a new field) opens the card for just that
   (`mode: 'complete'`, `covered` = the fields the vault fills).
3. `ask_user: true` (or a `reason`), or an account the agent may not use: the
   card (`mode: 'ask'`, with the username prefilled). With a username on a
   step that asks for the password, the agent says the site rejected that
   account's password: it is marked (`rejected_at`, audit `rejected`), and
   the card shows the agent's `reason`. A wrong code marks nothing.
4. An account with a `via`: the result names the provider account to pick;
   nothing is filled, unless the step asks only for its other parts (a
   workspace). A step that asks for a code (the site's own check after the
   provider's) opens the card for the code, as that account.

A saved password goes in without the user only while it signs in fine: not
for an account marked rejected (until the user enters its password again, in
any session), and not more often than a lockout allows: the vault fills it
by itself at most twice within 30 minutes (one retry after a hiccup) and
five times a day, counted since the user last signed in with the account
themselves (`filledTooOften`). Signing in that often is most often the site
turning the password down, and each attempt counts toward its lockout. The
count comes from the account's `used` audit rows, which say whether a
password went in and whether the vault or the user filled it, so it holds
across sessions, agents and restarts. Both open the card (`rejectedAt`,
`filledAt`).

The tool result names the account the values were for (a saved one, one the
user picked in the card, or the username they typed), so the agent names it
on the next step, and says what was saved or held, never a value. A password last typed on an https page is not filled into a
plain-HTTP one without the user (`vaultFillsInto`, against the account's
`origin`: where its password was last entered).

### Steps

A field mapped without a ref is a later step's: on an email-first page the
agent maps the email and the password without a ref, the user enters both,
and once the email went into the page the host holds the password in memory
(`held-values.ts`, 30 minutes, per agent, session and site). A later call on
the same site that maps a password field gets it filled without the user —
only where a saved account's password could go (no https-typed value into a
plain-HTTP page) — and only then is it added to the account, if the user
asked to save it and the account is still theirs and still granted (the next
step is not always a password). Declining, or signing in on the page by
hand, drops it. The host also remembers the username the last step went in
with, so a step without a username field still knows whose account it is.

A second step that offers several ways (a code by text, a prompt on the
phone, a passkey) is the user's to choose, also when the page opens on one
of them with "Try another way": the agent opens the list and asks which with
`AskUserQuestion` before it clicks one (the web-browser subagent reports the ways to the main agent,
which asks). A code then goes through request_login like any step, and is
never saved. After a prompt to the phone the agent waits for the page to
move on, and hands the browser over (`request_browser_input`) only if it has
not within about two minutes. This lives in the container, not the host: the
agent's prompts and tool descriptions, and a hint (`sign-in-verify-way`, see
`agent-container/src/hints/builtin/`) shown when a request_login call
returns, which is when that step comes up. Nothing enforces it: a missed
choice costs the user a hand-over, not the sign-in.

### The card

"Save for later" is on by default (off, with a notice, on an agent others can
use — its user and owner members, and every admin, who may drive any agent
(`countOtherMembers`): they could have it sign in as the user). It saves the account
and grants it to the agent, also when the user fills a login from their
password manager (Apple Passwords): the whole login, username and password,
even on a step that shows only the username, so the next step needs no one.
The card also offers the user's saved accounts for
the site (one click fills one and grants it) and "Or sign in with" a provider.
The buttons are the page's own: the agent lists the "Sign in with Google"
buttons it sees in request_login's `providers` (known provider ids only), the
container passes them through in the login context, and the card shows those,
never the site itself. The other providers and the user's saved accounts on
other sites (a company's own sign-in) sit under More, or under "Other ways to
sign in" when the page lists none. Picking one asks which account there (a
saved one, or an email), saves a `via` account and tells the agent which
provider account to use.

A fill the vault cannot complete as the card left it is refused with a
`reason` the card acts on: `fields_needed` (what it was to fill is gone — a
held value expired, a part was deleted: those fields are shown) or
`account_unavailable` (the account the host chose was deleted or revoked: the
card asks for every field rather than granting it again).

### When the browser closes first

A card outlives its browser. Closing the browser, or Browserbase ending its
session while the user is away, does not cancel a sign-in: the agent keeps
waiting, and the card stays (up to the 24-hour limit on any request). Nothing
can go into a page once the browser is gone (the container answers the fill
with `browser_closed`), and the user answers once: what they did is kept for
the agent's next try, which then needs no one. The agent is told to open the
sign-in page again and call request_login with the account's username
(`kept` in the result):

- A saved account the user picked is granted (`picked`).
- With "Save for later", what they entered (this step's fields, the next
  step's, and what an earlier step held to save) is saved and granted
  (`saved`).
- Without it, or when the save fails, what they entered is held in memory
  as a later step's would be (`held`, 30 minutes, this session).
- A login picked from the password manager goes by the same "Save for
  later": saved and granted, else held.
- An unattended fill the browser closed first opens no card: the agent is
  told to try again with the same account (`vault`).

Only a one-time code is not kept: the user is asked again.

## Settings → Logins

Each user's saved accounts, the agents allowed to sign in with each (the same
switches as Connections and Drives), rename and delete. Granting to an agent
others can use asks first. Deleting an account does not sign agents'
browsers out of the site; saved sessions (part 3) will.

## Parts 3 and 4

The tables are in place: `browser_account_sessions` holds an account's sealed
cookies and web storage per browser type (`sessionBundleSchema`, after
#1210's capture/restore primitives), and each grant records which session
version its agent's browser holds (`applied_session_version`). The sealed
`secrets` schema has room for a TOTP seed and passkeys (part 4).
