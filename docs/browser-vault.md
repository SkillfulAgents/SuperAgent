# Browser Vault

Agents sign in to websites without credentials passing through the model.
Part 1 (request_login) gave the agent a tool that maps a page's sign-in fields
by ref while the user types the values into a form in the app; the container
writes them into the page over CDP. Part 2 adds the vault: accounts the user
saved, filled by the host on the agent's request, step by step, only for the
agents the user granted them to. Part 3 saves each account's signed-in
session (cookies and web storage) after a sign-in and restores it into
another agent's browser, so a sign-in the user completed once (a code, a
phone prompt) does not need them again.

Code: `src/shared/lib/browser-vault/` (host), `agent-container/src/login-*.ts`,
`agent-container/src/browser-session*.ts`, `agent-container/src/session-routes.ts`,
`agent-container/src/browser-gate.ts`
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
   (`mode: 'complete'`, `covered` = the fields the vault fills). On a
   sign-in's first page, the account's saved session goes in first when the
   agent's browser has not had it, and nothing is filled (see Saved
   sessions).
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

## Saved sessions

Every browser type keeps a profile per agent (the container's in its
workspace, Chrome's in the data dir, Browserbase's and the platform's in a
persistent context), so an agent stays signed in by itself. A saved session
carries a sign-in to the account's other agents.

**What a session is.** An account's cookies, localStorage and IndexedDB on
its site, as the browser sends them there: cookies set for the site's host or
its subdomains, a parent domain's Domain cookies (Google's session is on
`.google.com`, its sign-in on accounts.google.com; a parent host's own
cookies never reach the site and stay out), and the storage of its host's and
subdomains' origins (a subdomain's on the site's scheme and port). Never a
sibling host: `acme.okta.com` and `beta.okta.com` are separate accounts.
sessionStorage belongs to a tab and is not saved. An account that signs in
through another (`via`) saves its own site's session; the provider's account
saves its own. One per account and browser type (`browser_account_sessions`,
sealed like the secrets, bound to the row): it restores only into the type it
came from (Chrome on a Mac signs nothing in on container Chromium, and Chrome
on Windows binds Google sessions to the device). Caches stay out (a
localStorage value over 64 KB, a database over 2,000 records or 512 KB, read
no further than that, a bundle past 1 MB), and so does a database that cannot
be read: one that does not open within 3 s (a deletion or upgrade the site
holds up), an unreadable value (a blob whose file is gone), a value nested
too deep to come back. A capture never creates a database: one the site
deleted meanwhile is gone, not saved empty.

**Capture.** Before each sign-in step the vault or the user's form puts into
a page, and before a provider is named for a `via` account, the host reads
the site's state (`sessionBaseline`: a fingerprint of its cookies and
storage, the container's `peek`). After the step it watches the site for
three minutes (`watchSignIn`): it looks 2 s after the step and every 15 s
after that, and the container sends the site back only when the fingerprint
differs from the last one saved (`unlessHash`). A change is saved to the
step's account at once when the site held still before it (a sign-in
landing, a push approved) or holds still after it; while it changes on look
after look (a cookie rewritten on every page), at most once a minute; and
once more when the watch ends. So the state a step started from is never
saved as its account's, and what
completes a sign-in without another call is: a phone prompt approved, a
provider's redirect landing back, a token the app stores (Supabase and
Firebase keep the session in storage alone). A step is watched only from a
sign-in's first page (a username field, provider buttons), or as a later step
of the one the session began on the site with the same username: elsewhere
(a password asked again, "Confirm access") the browser may be signed in as
another account.

Anything that may change who is signed in ends a watch, and nothing more of
that sign-in is saved: any sign-in step or restore in the agent's browser, on
any site and in any of its sessions (sites share a parent domain's cookies,
and a sign-in lands on another site), but the provider step of a sign-in
through it (`via`); a password manager's login; someone other than the
account's owner done with a hand-over or a sign-in card, or declining it;
the browser closing, opening again (`generation` in `/browser/status`),
passing to another session, or the session switching to another kind of
browser. While a hand-over or a sign-in card waits on the user, a watch does
not look: what happens in the browser then is theirs. A hand-over
(`request_browser_input`), or signing in on the page in place of the card,
that the owner finishes on the sign-in's site within 30 minutes of its step
looks at the site again at once and saves what changed since: a passkey, a
prompt that outlasted the wait. What a restore puts in is not watched: sites
rewrite a cookie on every page (load balancers, analytics, re-encrypted
framework sessions), and a session saved again for each would go round
between the agents that share it. A capture or a restore lets go of the
other accounts' marks (below) on every site of the registrable domain.

The capture reads on a hidden tab of its own, beside the agent's work.
agent-browser makes a tab it discovers the active one by itself, with no
command, and falls back to the last tab once that one closes, so a session
operation pins the daemon to the agent's tab while it runs (its `pinTab`,
set and cleared around the operation), and runs alone in the browser
(`browser-gate.ts`): it waits for the agent-browser commands under way (the
agent's, the container's own tab queries), and one that starts after it
asked waits for it.

**Restore.** Inside request_login, when an account is chosen on the first
page of a sign-in: the agent names it, or the user picks it in the card as it
is (a saved account, or one that signs in through a provider, with nothing
typed over it). A pick is how an agent that does not have the account yet
gets its session: the pick grants the account once the restore moved the
page, so one that moved nothing grants nothing, and the values fill as
before. The conditions: the page asks who is signing in (a username field)
or offers signing in with another account (provider buttons); nothing is held
for the step; it is not a code; the session's last step on the site was not
this account's (its next step is); and the page is not plain HTTP when the
account was saved on HTTPS. A password asked again on a signed-in page
(GitHub's "Confirm access") is not a first page, and a call that maps no
field restores nothing: to use another account on a site where it is signed
in, the agent signs out there first, and the site's own sign-out clears what
the vault cannot see (an API host's cookies, other tabs). The account's
session goes in unless the agent's browser already held that capture:
`version` is one sequence across all saved sessions (never one a browser is
still marked with), so a grant's `applied_session_version` names the capture
its agent's browser got (restored there, or captured from there; one account
per site at a time).

The container parks every tab on the site on a blank page of its own origin,
the agent's last, so no page of the site runs while its state is replaced
(a sign-in page writes its state on the way out, an app writes back the
token it holds in memory). A tab that cannot be parked and is still open (a
dialog holds its page) would write its account back once it runs again, so
the restore then fails before anything changed, and the values fill. It
empties the site (every cookie and origin in
scope: localStorage, IndexedDB, caches, service workers, the origin private
file system); writes the session, cookies last; and sends each tab back to
its URL, with its history reset so no stub (nor the page it left, in the
back cache) stays behind. The agent's tab then settles before the agent is
told where it is (`SETTLE_TIMING`): a page the session signs in may move on
by itself seconds after it loads (Google's sign-in page checks the session
in its scripts and goes on to Gmail, 2 to 5 s after its load, after a quiet
second and a half), and an agent told at the load saw the sign-in page and
signed in again. So the page gets 5 s to move on, and more while anything
moves (a navigation, a request in flight but a long poll) until 1.5 s pass
with nothing; once it has gone on, a second with no further navigation is
enough, however long the new page takes to load; never more than 8 s after
the load. The agent is told the session was restored and the
page loaded again (`type: 'session'`), and calls again if the page still asks
to sign in: the same capture never goes in twice, so that call fills the
values, and the watch saves the new sign-in over the old session. A restore
that fails after it changed something empties the site rather than leave two
accounts' state mixed; one that fails before only moved the page, and the
agent is told the site was left as it was; one that fails before it moved
anything fills in the same call. A restore counts as a use in the audit log
(`session: true`), never as a password fill.

**Limits.** A session spans more than the site's scope when its auth is
held elsewhere: an API host's own cookie on a sibling (`api.example.com`)
or another site (an identity provider's tenant) is neither saved nor
cleared, so the app signs in only where it keeps its tokens in its own
storage, and the next call fills the values otherwise. Likewise a sign-in
page on a sibling of the app (`login.example.com` for `app.example.com`)
saves the sign-in host's state, not the app's. The container logs what a
watched sign-in changed outside the account's site (`[Session] Outside …`:
the cookie domains of the site the agent's tab is on, with counts, and one
count for every other domain, never a name or a value), so a sign-in that
lands on another site (WSJ on wsj.com after Dow Jones' sign-in page) shows
what its saved session leaves out. A site on the bare
domain takes in its subdomains' sites (an account on amazon.com saves the AWS
console's cookies too), and a parent domain's Domain cookies can hold every
account signed in at once (Google, Slack's `d`): sign the others out before
signing in with an account whose session other agents get. The storage of
a subdomain no tab, history entry or cookie names is not emptied by a
restore (Chrome lists no origins that hold storage). A sign-out within the
three minutes of a watch is saved as the account's session; the next
sign-in replaces it. Concurrent use of one session by two browsers can sign
both out on a site that rotates its refresh token with reuse detection; the
next call then fills the values. A session is refreshed by the next sign-in,
not while an agent works. A restore empties what a capture left out for its
size (a large cache), which the site fetches again. Revoking a grant,
deleting an account or forgetting its sessions does not sign agents'
browsers out: they keep what they hold until the site ends it.

## Settings → Logins

Each user's saved accounts, the agents allowed to sign in with each (the same
switches as Connections and Drives), rename and delete. Granting to an agent
others can use asks first. An account shows where it has a saved session and
since when, and Forget drops them (its next sign-in fills its values).
Deleting an account deletes its sessions; neither signs agents' browsers out
of the site.

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

## Part 4

The sealed `secrets` schema has room for a TOTP seed and passkeys.
