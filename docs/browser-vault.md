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
and grants it to the agent. The card also offers the user's saved accounts for
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
- A login picked from the password manager is held the same way, never
  saved: it lives in the password manager.
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

## Part 4

The sealed `secrets` schema has room for a TOTP seed and passkeys.
