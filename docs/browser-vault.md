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
one-time code is never a part. The key is the vault's own, 32 random bytes,
held by the installed KeyManager (see [Key custody](#key-custody)). It is not
the auth secret: setting, rotating or resetting that never locks the vault. An
account sealed under another key fills nothing (the user is asked), and is
saved over only with every part it lists, never by dropping the rest. A vault
whose key cannot be had here at all (a locked keychain) fills nothing and saves
nothing, and says what to do (`VaultUnavailableError`).

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
and once the email went into the page the host holds the password
(`held-values.ts`, per agent, session and site). A later call on
the same site that maps a password field gets it filled without the user —
only where a saved account's password could go (no https-typed value into a
plain-HTTP page) — and only then is it added to the account, if the user
asked to save it and the account is still theirs and still granted (the next
step is not always a password). Declining, or signing in on the page by
hand, drops it. The host also remembers the username the last step went in
with, so a step without a username field still knows whose account it is.

Both live in AppState (`vault:held`, `vault:identity`; see
[docs/app-state.md](app-state.md#browser-vault-handoffs)), so every process
serving the tenant sees them. Held values last 30 minutes from when they were
held; using some of them does not renew the rest. The identity lasts 30
minutes from the last step that went in. Held values are stored as typed
for now (sealing them is a follow-up). They never go into a key, an event, a
log or a result; they leave the host only through the container's fill
endpoint.

A held value goes into a page once at most. A fill takes the held parts it
sends before sending them, so a second call racing for the same step does not
get them (it is decided again without them, and the user is asked for what
is missing). Once the browser answers, what went in, or may have, is dropped,
and what it could not write is there for the next try. A fill the page or
browser refused leaves everything held. A fill sent without any answer counts
as having gone in, as does a fill whose process went away: its parts are
dropped after five minutes, never offered again.

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
held value expired or another fill took it, a part was deleted: those fields
are shown) or
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
- Without it, or when the save fails, what they entered is held as a later
  step's would be (`held`, 30 minutes, this session), along with what an
  earlier step still holds.
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

## Key custody

`vault-crypto` seals with `keyFor('browser-vault')` and knows nothing of where
the key lives. Each entry point installs a KeyManager
(`src/shared/lib/keys/key-manager.ts`) after `openDatabase()` and before
anything is served; nothing is chosen at import, and asking before the install
is a `not-installed` error, not a key from somewhere. The manager serves one
app (or tenant) scope for its lifetime.

| Entry point | Manager | Where the key is |
|---|---|---|
| Electron main | `DesktopKeyManager` (`src/main/keys/`) | Wrapped by Electron `safeStorage` (macOS Keychain, Windows DPAPI, libsecret/KWallet) in `<data dir>/.vault-key.wrapped`. Without a keyring (Linux `basic_text`, or a keyring that does not answer): `<data dir>/.vault-key`, as before |
| Web server, Vite dev server | `ServerKeyManager` | `SUPERAGENT_VAULT_KEY` (base64) or `SUPERAGENT_VAULT_KEY_FILE` (a mounted secret); with neither, `<data dir>/.vault-key`, as before |
| Cloudflare (later) | `CloudflareKeyManager` | A Worker secret or Secrets Store binding, provisioned by deployment tooling. The consumers don't change |

Neither the OS's key nor the unwrapped vault key is ever in the database. The
wrapped file alone opens nothing.

On Linux, Electron's async `safeStorage` reports itself available even when
the Secret Service doesn't answer. It then encrypts with Chromium's fixed
password, tagged `v10` (a real keyring key is `v11`). The manager wraps a
sample first and treats `v10` as "no keyring", so a key is never presented as
protected when anyone could unwrap it. On macOS and Windows, `v10` is the real
Keychain or DPAPI key.

**Never a new key over sealed data.** Before a manager makes, moves or uses a
key, it checks the key against the vault's latest sealed values
(`probeVaultKey`): a key that opens none of them is a `mismatch`, and with no
key at all while values are sealed, it reports `missing` instead of making one.
A damaged key file is never written over, and a locked keychain is never
replaced by a plaintext key. In each case the vault reports the reason and
`KeyUnavailableError.userMessage` says what to do. Startup is not blocked: the
app runs, and the vault works again once the cause is fixed (failures are
retried, not remembered).

**Moving into the keychain.** On the first start after an upgrade, a desktop
that has `.vault-key` and a usable keyring moves the key in unchanged. Before
anything is written, the OS must give the wrapped key back as the same bytes,
and those bytes must open the sealed data. Then the wrap is written. Once
written, it is never deleted: another process may already be using it.
`.vault-key` is deleted only after the wrap on disk reads back as the same key.
On Windows the OS store's own key is a DPAPI-wrapped value in `Local State` in
Electron's `userData` folder, which Chromium writes about ten seconds after it
makes the key; a crash before that loses the key, and every wrap made with it.
So `.vault-key` also stays until `Local State` holds a key, and a wrap replaced
because it did not open keeps `.vault-key` until the next start opens the new
wrap from disk. A brand-new key waits for `Local State` before it is made, and
the call fails with a retry message if it never appears. A move cut short finishes on the next start: if the wrap was written, the
leftover copy holding the same key is deleted; if the wrap was cut off
mid-write, the move runs again from `.vault-key`. If the wrap can't be opened
on this computer (it came from another computer, or the keyring can't open it)
and `.vault-key` opens the saved logins, the file is the key: it is wrapped
here in place of the old wrap, or used in plaintext if there is no keyring.
Two different keys that both open here are a `conflict`, and the user picks
one. If the OS asks for a re-wrap (`shouldReEncrypt`), the new wrap is checked
before it replaces the old one.

**Backup, restore, another computer.** A backup of the database alone does not
recover a desktop vault: the key is bound to that computer's OS store. File →
**Export Browser Vault Key…** writes the key (in `.vault-key` format) to a file
the user picks, entirely in the main process: the key never crosses IPC, and
never reaches a log or an agent. To move the vault, copy Gamut's data folder to
the other computer and put the exported file in it as `.vault-key` before Gamut
first starts there. That start checks the file against the copied logins and
moves it into that computer's OS store, replacing the copied
`.vault-key.wrapped`, which only the old computer can open. Data folders: macOS
`~/Library/Application Support/Superagent` (Mac App Store:
`~/Library/Containers/<bundle id>/Data/.superagent`), Windows
`%APPDATA%\Superagent`, Linux `~/.config/Superagent`. On a server, back up the
key with the database: the `SUPERAGENT_VAULT_KEY` secret, or the data
directory's `.vault-key`. A server can switch to the secret by setting it to
that file's contents; the file is then ignored (logged), and can be deleted.

A key that is lost is lost. Logins sealed under it can be deleted in Settings →
Logins, and once none remain, a new key is made on the next save.

## Parts 3 and 4

The tables are in place: `browser_account_sessions` holds an account's sealed
cookies and web storage per browser type (`sessionBundleSchema`, after
#1210's capture/restore primitives), and each grant records which session
version its agent's browser holds (`applied_session_version`). The sealed
`secrets` schema has room for a TOTP seed and passkeys (part 4).
