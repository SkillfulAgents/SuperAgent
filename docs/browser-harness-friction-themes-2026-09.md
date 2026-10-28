# web-browser harness friction — merged themes (Lane A synthesis)

Source: 1,811 findings from 200 production `web-browser` subagent sessions (67 high-friction,
66 long/low-detector, 67 random; all post-2026-06-12 audit), clustered per-area into 14 files and
merged here by **mechanism / shared fix**. Reviewer-judged waste: 4,381/10,635 calls (41%) in the
high-friction stratum, 1,686/5,260 (32%) long-low-friction, 612/1,963 (31%) random.

Wasted-call sums are reviewer estimates and double-count across areas — **relative weight only**.
Ranking = distinct sessions × max severity, wasted calls as tiebreaker. All harness locations were
verified by grep in `/home/iddogino/Code/SuperAgent/.claude/worktrees/browser-enchancments/agent-container/src`.

---

## Executive summary — the five changes that remove the most waste

1. **Give the agent page text.** `server.ts:1453` makes `-i -c` the default, which deletes every
   StaticText node with no marker; `fullText` also drops `-c`, and `browser_get_state` hardcodes
   `{interactive:true,compact:true}`. Add `browser_text(scope?,offset?,limit?)` + an omission footer.
   ≈142/200 sessions, ≈930 wasted calls.
2. **Return the settled page, not the request.** `/browser/open` already reads the landed URL at
   `server.ts:1294` and throws it away; no snapshot carries URL/title/status/readyState. One header
   line + a real open result. ≈130/200 sessions, ≈1,200 wasted calls.
3. **Make the action digest carry the effect.** `formatUrlDigest` compares URL strings only and then
   says "Re-snapshot only if you need to see resulting DOM changes." Add a DOM/top-layer/aria-live
   delta and delete that clause. ≈118/200 sessions, ≈960 wasted calls.
4. **Shrink the snapshot.** Collapse closed `<select>` option runs, dedupe parent-name=children and
   wrapper chains, fold identical sibling runs, diff against the previous tree. Boilerplate — not
   task size — is what forces the mid-task compactions that lose extracted data. ≈88/200 sessions,
   ≈700 wasted calls plus 2–7 compactions per long session.
5. **Classify browser failures once.** Every CLI failure collapses to `Command failed: agent-browser
   <argv>` (`server.ts:875-908` falls back to `error.message`), and a dead session reaches the model
   as `410 Gone` / `Browser is not active` with no cause and no remedy. One `classifyBrowserFailure()`
   + auto-reopen + `location="container"` fallback + a disclosure duty. ≈95/200 sessions, ≈950 wasted.

---

## Ranked merged themes

| # | Theme | Sessions /200 | Wasted | Sev |
|---|---|---|---|---|
| 1 | Text-blind snapshot / no page-text primitive | ~142 | ~930 | 5 |
| 2 | No page identity or readiness on any result | ~130 | ~1,200 | 5 |
| 3 | Action digest reports URL, not effect | ~118 | ~960 | 5 |
| 4 | `browser_eval` wrapper: false return-note + parse sniffing | ~112 | ~130 | 5 |
| 5 | Tree is not layer-aware (overlays, portals, occlusion) | ~97 | ~520 | 5 |
| 6 | Snapshot boilerplate exhausts context | ~88 | ~700 | 5 |
| 7 | Widget state not encoded | ~88 | ~330 | 5 |
| 8 | `scope` is unusable and amplifies size | ~86 | ~400 | 5 |
| 9 | Refs renumber, rebind silently, error without provenance | ~80 | ~500 | 5 |
| 10 | `browser_wait` is one mode, cannot fail, cannot pace | ~74 | ~380 | 5 |
| 11 | Cross-origin iframe footer is wrong and preaches payment | ~70 | ~170 | 5 |
| 12 | Repeated-record structure destroyed | ~66 | ~290 | 5 |
| 13 | Unnamed / mis-named controls | ~62 | ~150 | 5 |
| 14 | NAVIGATED verdict from a racy string compare | ~61 | ~180 | 5 |
| 15 | Browser death & launch failure unclassified | ~58 | ~700 | 5 |
| 16 | Scroll acts on and measures the wrong element | ~56 | ~300 | 5 |
| 17 | No page/tab provenance; one browser, many sessions | ~55 | ~730 | 5 |
| 18 | Pixel space undisclosed; no coordinate click | ~55 | ~430 | 5 |
| 19 | Contentless success strings; digest only on 2 verbs | ~55 | ~190 | 5 |
| 20 | No geometry / graphics census | ~50 | ~210 | 5 |
| 21 | `Command failed: <argv>` for every failure class | ~50 | ~200 | 5 |
| 22 | Truncation is lossy, mis-stated and uncontinuable | ~50 | ~90 | 5 |
| 23 | `browser_get_state` is non-atomic and un-knobbed | ~48 | ~107 | 5 |
| 24 | Fill/select read-back overclaims and blames the site | ~45 | ~220 | 5 |
| 25 | Capabilities exist but are undiscoverable | ~52 | ~210 | 4 |

Themes 26–51 are in the table after the detailed sections.

---

## 1. Text-blind snapshot — the default deletes all page text and nothing says so

**≈142/200 sessions · ~320 findings · ~930 wasted · sev 5 · novelty: variant_of_known
(`snapshot_insufficient`, `eval_for_extraction`) — the detectors see the escalation, not the omission**
Fed by: snapshot_vs_screenshot T1; snapshot_content STATICTEXT, FULLTEXT; tool_surface #7, #25;
surprises T12; prompt_guidance #9.

**Mechanism.** `server.ts:1453` pushes `-i -c` whenever `fullText` is unset, and each flag
independently strips StaticText: prices, prose, validation errors, empty-state copy, step counters,
status text, table values. The result carries no marker that anything was dropped and no pointer to
`fullText`, so the agent concludes the fact is not on the page and switches to screenshots (read by
eye) or hand-written `innerText` scrapers. `fullText` is not additive — it drops `-c` too, tripling
output — and `browser_get_state` (`tools/browser.ts:643`) hardcodes `{interactive:true,compact:true}`
so the one call that pairs an image with a tree can never see text.

**Evidence.**
- `agent-a52a47376d0ba33e8` (8 snapshots, shots/005,008,011): "Every ad card's 'Active' badge,
  'Library ID: <n>', 'Started running on <date>' … the task's entire dataset — visible on all 25 cards
  … and present in zero of eight snapshots".
- `agent-afc8d7540b9f02e39` (call 284 of 377): "The section's explanatory paragraphs … only reachable
  via fullText, discovered at call 284 of 377".
- `agent-a3dcd187d3e6b6d0c` (step 117): "an interactive snapshot listing only `textbox "Talk to me,
  Goose…"`, with no headings and no indication that static text was omitted" → shipped a factually
  wrong "NOT REPRODUCED" verdict.
- `agent-acf712dbcb158f2e5` (steps 16-81): "return document.body.innerText.slice(0,1500) — 34 times in a row".
- `agent-a30cabe8199f80037` (call 90): "the winning technique — document.body.innerText — was
  available at call 1, beat the accessibility snapshot on completeness, size and parseability, and is
  not in the toolset".

**Fix.** (a) New tool `browser_text({scope?, offset?, limit?, pattern?})` returning rendered text
(Readability main region by default, `innerText` of a scope, match+context for a pattern) with a byte
range and a `more` marker; name it in the prompt's tool list and in `capSnapshot`'s truncation hint.
(b) Footer on every filtered snapshot: `142 static text nodes omitted (prices, errors, prose) — pass
fullText:true`, computed by diffing node counts or a `document.body.innerText` length probe.
(c) Always keep `role=alert|status|aria-live` and `<main>`'s first text block in the default view.
(d) Decouple `fullText` from `-c`: inject StaticText into the compact tree, re-join a paragraph's
inline runs, suppress a StaticText child equal to its parent's name. (e) Give `browser_get_state` the
snapshot tool's parameters plus `screenshot:false`.

**Files.** `server.ts:1449-1458`; `snapshot-format.ts`; `tools/browser.ts:169-235` (snapshot),
`:637-690` (get_state); `web-browser-agent-prompt.md`.

**Hook.** `browser_snapshot`/`browser_get_state` with `fullText` unset followed within 3 calls by
`browser_screenshot` or a `browser_eval` matching `innerText|textContent|innerHTML` on the same URL;
per-session `fullText` usage rate; sessions with ≥5 screenshots and zero text-returning calls.

---

## 2. No page identity or readiness on any result

**≈130/200 sessions · ~370 findings · ~1,200 wasted · sev 5 · novelty: new (partially overlaps `blocked_external`)**
Fed by: action_result `open_no_outcome`; misleading "browser_open announces an intention",
"Snapshots carry no page-status line"; snapshot_content PAGESTATE, LOADING; snapshot_vs_screenshot
T5, T10; wait_timing D; surprises T8; tool_surface #11; auth_or_blocker T4.

**Mechanism.** `/browser/open` runs `agent-browser get url` at `server.ts:1294` purely to seed the
digest baseline, then returns `{success, location, switchedFrom}`; the tool text is composed from
`args.url` (`tools/browser.ts:147`), so "Browser opened … and navigating to <url>" is byte-identical
for a 200, a 429, a redirect to login, `about:blank` and a dead browser. No snapshot, screenshot,
eval or scroll result carries the URL, title, HTTP status or `readyState`. `(no interactive elements)`
is therefore emitted identically for a still-hydrating SPA, a 404 shell, a Chrome net-error page, a
bot interstitial, a JSON body in Chrome's viewer, and a page inert behind an overlay.

**Evidence.**
- `agent-a3b9ba43fcebe3c1f` (steps 4-9): "browser_open said … navigating to https://soundmasters.pro/…
  and the next browser_snapshot returned the Beatport Afro House Top 100 with no URL, no title, no
  heading anywhere in the output".
- `agent-aaa72aa0e5faf8bc2` (steps 10-165): "*Browser opened and navigating to https://drinkolipop.com*"
  for an HTTP 429 whose body was `local_rate_limited`; the truth arrived at call 165 from
  `browser_run("network requests")`. 120 wasted calls.
- `agent-a9b14c363a18716cd` (30 pages): "the agent compiled its final report and only THEN discovered
  it had been scraping a sign-in page — 30 consecutive '[]' results were indistinguishable from 30
  genuinely empty pages".
- `agent-a88fffbc8116dd78c` (steps 1-31): HTTP 401 invisible — "browser_snapshot at calls 2, 10, 18
  and 22 returned exactly `- checkbox "Pretty-print" [checked=false, ref=e1]`".
- `agent-ad4e93485d2679bea` (shots/007, 009): "The Imperva ban page snapshots as exactly two lines …
  'Access denied / Error 15 / … / Your IP … / Incident ID' exists only in shots/007.png".

**Fix.** One readiness probe in the eval slot that already runs `IFRAME_ENUM_SCRIPT`, surfaced in
three places. (a) `/browser/open` returns `Loaded "<title>" at <final url> (redirected from <req>) ·
HTTP 200 · readyState complete · 84 interactive nodes`, fails loudly when the document never
committed, and takes `observe:"snapshot"|"screenshot"|"none"` so the universal follow-up disappears.
(b) Every snapshot/get_state/screenshot gets a header line `URL · title · HTTP · readyState ·
N interactive / M total · viewport WxH`. (c) When the tree has <5 refs, auto-append capped
`document.body.innerText` plus a state flag — `chrome-error://`, non-HTML content type, skeleton /
`aria-busy` / `role=progressbar` count, in-flight request count, and a bot-block classifier keyed on
title/body signatures (Cloudflare, Imperva, Akamai, Google `/sorry`) and cookies (`_px*`,
`cf_clearance`, `__cf_bm`, `datadome`, `incap_ses`). Drop the prompt's "browser_open already waits for
the page to load".

**Files.** `server.ts:1181-1305` (open; the discarded `landed` read at 1294), `:1424-1490` (snapshot);
`snapshot-format.ts`; `tools/browser.ts:112-151`; `browser-navigation.ts`; `web-browser-agent-prompt.md`.

**Hook.** `browser_open` results followed within 2 calls by `get url` / `document.title` /
`location.href` / snapshot; snapshot bodies containing `(no interactive elements)`/`(empty page)` or
<3 ref tokens, counting what follows within 3 calls; any session where a later snapshot of the same
URL is non-empty; snapshots <400 chars followed by a screenshot.

---

## 3. The action digest reports the URL, not the effect — and argues against verifying

**≈118/200 sessions · ~250 findings · ~960 wasted · sev 5 · novelty: variant_of_known
(`click_no_effect`, `poll_by_snapshot`) — neither names the missing change channel; the advice line is new**
Fed by: action_result `url_only_digest`, `click_noop`; misleading "URL-unchanged click digest";
surprises T4; prompt_guidance #10; snapshot_content LIVE; snapshot_vs_screenshot T13.

**Mechanism.** `formatUrlDigest` (`browser-digest.ts`) is the entire post-action state for click,
press, hover and select. Its module header records that the tree-diff was "deliberately deferred", so
the digest has no DOM channel at all: on any SPA it prints `URL unchanged (<url>). Re-snapshot only if
you need to see resulting DOM changes.` whether a dialog opened, a toast fired, a row was added, the
click was swallowed, or a destructive action started. Live-region text (`role=status|alert`,
`aria-live`) is gone before any later snapshot can see it, and the interactive filter would drop it
anyway. The prompt then says "Trust the action results", so sessions either over-trust and ship wrong
work or pay a snapshot per click.

**Evidence.**
- `agent-afc8d7540b9f02e39` (steps 24-363): "`Pressed \"ArrowUp\". (URL unchanged)` roughly 150 times,
  on a single-URL SPA"; ~80 extra evals interleaved to see what happened.
- `agent-a976822efe0700ff7`: "'URL unchanged … Re-snapshot only if you need to see resulting DOM
  changes' covered for a 'See more' click that did nothing, and the agent told the user 5 creative
  groups were Intercom's complete active ad set on a page reading '~230 results'".
- `agent-a46f80b5253e10c04`: "a destructive modal opened and the action result said only '(URL
  unchanged)'" — on an explicitly read-only task.
- `agent-a37a73828124caf58` (steps 14-36): "*URL unchanged … Re-snapshot only if you need*" while a red
  "Cart Error" toast rendered and `/cart/add.js` returned 422; the agent monkey-patched `window.fetch`.
- `agent-a3950fba184e44d4e` (steps 46-47): "a post-submit snapshot showing a blank form … the green
  toast 'Request # TP-FAKZA425 submitted…' is only in the image".

**Fix.** In the click/press/select handlers, fingerprint before and after the settle: interactive node
count + a top-layer probe + a hash of the subtree around the target, and drain a page-init
`MutationObserver` on `[aria-live],[role=status],[role=alert]` plus any ≥400 network response since
the action. Emit `dialog "Create new app" opened · 34 new refs · announced: "Tags updated
successfully"` or `no DOM change detected — the element may not be handling clicks`. Delete
"Re-snapshot only if you need to see resulting DOM changes." Report the focused element for `press`.
Scope the prompt's rule 4 to navigation and to click/fill/press/select, explicitly excluding
`browser_open`.

**Files.** `browser-digest.ts` (`formatUrlDigest`, `formatUrlDigestBrief`); `server.ts:1493-1526`
(click), `:1650-1690` (press); page-init script injection beside `credential-autofill-script.ts`;
`web-browser-agent-prompt.md` Core Workflow §4.

**Hook.** Click/press results matching `URL unchanged \(` where the next snapshot within 3 calls
differs from the previous by >5% of lines (the agent was right to distrust); separately, `URL
unchanged` results with no following observation whose next action uses a pre-click ref (the silent
half); clicks followed by a screenshot with no snapshot where the next assistant message quotes text
absent from every prior snapshot (toast-only facts).

---

## 4. `browser_eval`'s wrapper: a false note on every result, and a parse sniff that breaks valid scripts

**≈112/200 sessions · ~180 findings · ~130 wasted · sev 5 · novelty: covered_by_known_detector
(`misleading_return_hint`) for the note; the sniffing half is new**
Fed by: misleading "add `return` note"; error_message T3, T19; tool_surface #22; engine E6;
prompt_guidance #2; other T4; action_result `unconditional_footers`, `eval_fidelity`.

**Mechanism.** `tools/browser.ts:567-569` appends "(note: ran in a fresh function scope — add `return`
if you expected a value back)" whenever `data.wrapped` is true — not when the result was empty — so it
rides on essentially every statement-body eval, at 100% false-positive rates. `data.wrapped` comes
from `prepareEvalScript`, which decides by prefix regex: a script whose first token is `function` is
treated as a lone function literal and auto-invoked, so a later top-level `const`/`return` becomes a
SyntaxError quoting a token the agent did not write first — while the tool description promises
top-level `return`/`await`. The same path cannot distinguish `null`, `""`, a swallowed throw and a
pending Promise (all render as `null`/`{}`), and `browser_run("eval …")` is a different grammar again.

**Evidence.**
- `agent-a266cd6b8baa3a558` (steps 266-352): "18 of 19 evals used return and got their value back;
  zero true positives".
- `agent-ae8be85ebf4ce8c37` (steps 48-130): "only once (call 104, output null) was it actually
  applicable … the one true instance was indistinguishable".
- `agent-a80180ab5efa3bb4f` (steps 20, 29): "`SyntaxError: Unexpected token 'const'` — the script's
  first token is `function`".
- `agent-a9b14c363a18716cd` (step 17): "SyntaxError: Unexpected token 'return' — while call 15, the
  same shape but starting with an assignment, ran fine".
- `agent-a922bfc1480e94872` (steps 26, 60): "a bare '{}' — no value, no error, no note that a pending
  Promise was returned"; on the second occurrence the measurement the task asked for was lost.

**Fix.** (a) One condition: emit the note only when `data.wrapped && (!data.output || data.output ===
'undefined' || data.output === '(no output)')`. (b) Stop sniffing — wrap every script as an async
statement body and auto-return the completion value of a trailing expression (devtools semantics);
auto-invoke only when the whole script parses as a single function expression. (c) Await a returned
Promise and return a typed envelope: `null (script returned null)` / `"" (empty string)` /
`threw TypeError: …`; print strings raw and pretty-print parsed JSON; stop double-encoding. (d) Route
`browser_run("eval …")` through the same untokenized transport and hard-error an unparseable argument
instead of echoing it back as if it ran. (e) On any evaluation SyntaxError, echo the transformed
script actually sent.

**Files.** `tools/browser.ts:552-576`; `eval-script.ts` (`prepareEvalScript`, `isFunctionLiteral`,
`scanTopLevel`, `finalizeEvalOutput`, `evalErrorHint`); `browser-command-args.ts`;
`server.ts` POST `/browser/eval`.

**Hook.** Existing `misleading_return_hint`, reported as a per-session false-positive rate; plus
`SyntaxError: (Unexpected token|Illegal return)` where the submitted script parses standalone, and
consecutive evals differing only by an added `return`/IIFE wrapper; results whose whole body is
`{}`/`null`/`""` followed within 2 calls by a screenshot or a re-run.

---

## 5. The tree is not layer-aware — overlays, portals and occlusion are invisible

**≈97/200 sessions · ~200 findings · ~520 wasted · sev 5 · novelty: variant_of_known
(`dialog_probe`, `covered_by`, `custom_widget`) — the snapshot-side blindness is new**
Fed by: snapshot_vs_screenshot T3, T7; snapshot_content OVERLAY; misleading "covered-by" (snapshot half).

**Mechanism.** Top-layer content (dialogs, drawers, menus, comboboxes, cookie walls, CDK/Material
overlays) either never reaches the tree, or arrives as ordinary trailing siblings 100–500 lines below
its trigger with no `[modal]`, no scrim, no z-order, no inert marking of the page behind it, and
sometimes renumbered from `ref=e1`. The inverse also happens: a drawer collapses the tree to itself
with no note that a page exists behind it, and occluded nodes are listed as ordinary and actionable.
The harness *computes* occlusion — it produces "covered by `<div…>`" on click — but only reactively,
after a wasted click, and never in the snapshot. Portal-mounted popups frequently miss the flat
`CLICK_SETTLE_MS = 300` window entirely.

**Evidence.**
- `agent-a8e5dcb5eb889d4be` (screenshot 005 / snapshot result 29): "a 'Project created' modal over the
  project settings page with a 'Discard changes?' dialog over that; snapshot result 29 lists all three
  layers as flat siblings with no dialog role and no occlusion marking".
- `agent-a243326d7ae2dc490` (steps 13-38, 57-62): "a snapshot of the page behind the popup; scoped
  snapshots returned 'did not match any element' … the popup was plainly visible in the screenshot".
- `agent-a221f31de2314b44e` (screenshots 002, 004): "the workspace listbox options were in the tree but
  portal-mounted at document end, ~140 lines past the trigger; the agent … twice concluded they were
  unreachable".
- `agent-ae454d50a96b7fe47` (shot 001): "Klaviyo 10%-off modal with a visible X … completely absent
  from the snapshot; the harness knew it existed only via the 'covered by
  <div.needsclick.kl-private-reset-css-Xuajs1>' click error".
- `agent-aae7d24d2a8bf646e` (shots/012.png): "The kebab menu was never snapshotted: shots/012.png shows
  FIVE items … and a destructive-looking item sat ~200px below the click target the agent aimed at by
  pixel measurement".

**Fix.** A `formatOverlayHeader` peer to `formatIframePlaceholders`, fed by a top-layer probe
(`:modal`, `dialog[open]`, `[role=dialog]`, an `elementsFromPoint` sweep, highest-z fixed
full-viewport elements). Print it **above** the tree: `— TOPMOST OVERLAY — dialog "Share" box=…
covers refs e12–e88`; hoist portal-mounted subtrees next to their trigger; tag the rest `[inert]` and
occluded refs `[covered by e12]`. Add `Opened overlay: role=menu, 8 items, refs e90–e97` to the click
digest, and settle-poll instead of sleeping a flat 300 ms when the clicked ref carried
`aria-haspopup`/`aria-expanded`.

**Files.** `snapshot-format.ts` (new `formatOverlayHeader`); `server.ts:1467-1482` (snapshot probe),
`/browser/click` (the occlusion computation already there); `browser-digest.ts` (`CLICK_SETTLE_MS`).

**Hook.** A click/press followed by ≥2 snapshots whose text lacks `dialog|listbox|menu`, then a
`browser_eval` matching `role="dialog"|position:fixed|outerHTML`; any `covered by` error whose
covering selector never appeared in the preceding snapshot; a click on a ref whose line contained
`expanded=false|haspopup` followed by a snapshot with no new `menu|listbox|dialog` node.

---

## 6. Snapshot boilerplate — not task size — is what exhausts the context

**≈88/200 sessions · ~220 findings · ~700 wasted (plus 2–7 compactions/session) · sev 5 · novelty: new
(`large_output` sees one oversized result, not the cross-snapshot repetition)**
Fed by: misleading "Snapshots re-emit large unchanging boilerplate"; snapshot_content DEDUPE, SELECT,
DIFF, NAMEHYGIENE; surprises T10; other T10.

**Mechanism.** Nothing de-duplicates inside a snapshot, across consecutive snapshots of the same URL,
or across repeated accessible descriptions. A closed `combobox [expanded=false]` still emits one
ref-bearing line per `<option>` (249 country + 63 state, 53–55 languages). A container's computed name
is the concatenation of its children and then the children are printed too. Wrapper chains, identical
sibling runs and app-shell chrome are re-emitted verbatim on every call, and names composed from
`<style>` text or `sr-only` copy reach 400–4,000 chars, clipped at ~100 with no ellipsis. The
consequence is mid-task compaction, which destroys extracted data and ref memory and produces wrong
final numbers.

**Evidence.**
- `agent-aabb22c97745f184b` (~170 snapshots): "filtering out only Instagram's expanded 55-option
  language <select> and its 15 static footer links removes 10,013 of the transcript's 23,432 lines".
- `agent-a266cd6b8baa3a558` (148 snapshots): "a quarter of everything this model read was `- option
  "Bahasa Melayu"` … which drove five context compactions, which destroyed 60+ carefully-read view counts".
- `agent-a75379256dba80178` (steps 15-21): "each Gmail row emits the same ~400-char accessible name up
  to six times (row, gridcell, checkbox, gridcell, link) — ~1.8 KB per row".
- `agent-a6369ec091fc4db8a`: "~40 lines of byte-identical sidebar/nav chrome re-emitted in each of 75
  bare snapshots — the proximate cause of four context compactions".
- `agent-a976822efe0700ff7` (steps 15-79): "a single `button "Italian women in Sardinia eat pasta…"`
  node is ~4000 chars" → 9 snapshots truncated at 45,000 chars.

**Fix.** One post-CLI pass in `snapshot-format.ts`, before `capSnapshot`: (1) collapse a non-expanded
`select`/`listbox` to `combobox "Language" [expanded=false, 53 options]: English`, expanding only when
`[expanded=true]`, scoped to it, or on `expandOptions:true`; (2) suppress a node's name when it is the
concatenation of the descendants being printed; (3) collapse a wrapper whose only child has the same
name; (4) fold runs of ≥5 same-role siblings with equal or empty names into `button ×229 [unnamed,
refs e120…e349]`; (5) exclude `<style>`/`<script>`/`aria-hidden` text from name computation and cap
names at ~200 chars **with** `…[+N chars]`; (6) keep a per-session last-tree cache per URL to support
`browser_snapshot({since:"last"})` and an automatic `[nav/footer unchanged since your last snapshot —
40 lines elided]`.

**Files.** `snapshot-format.ts` (new pass before `capSnapshot`); `server.ts:1459-1483`;
`browser-digest.ts` (it already keeps per-session URL state); `tools/browser.ts` (annotate legend).

**Hook.** Per session: total snapshot chars ÷ distinct snapshot chars; fraction of lines identical to
the previous snapshot of the same URL (flag >60%); count of `- option "` lines as a share of tool
output; any name string appearing ≥5 times in one result; number of compaction boundaries in sessions
visiting <40 pages.

---

## 7. Widget state is not encoded — selected, pressed, current, disabled-why

**≈88/200 sessions · ~170 findings · ~330 wasted · sev 5 · novelty: variant_of_known (`custom_widget`);
the CSS-derived-state gap is new**
Fed by: snapshot_vs_screenshot T4; snapshot_content STATE, ROLEVOCAB; misleading "The snapshot asserts
element state and names that contradict what is rendered".

**Mechanism.** The tree carries `[checked]`/`[disabled]` for native controls and nothing else: no
`aria-pressed`/`aria-selected`/`aria-current`, no class-based selection for chips, tabs, swatches,
calendar days or pagination, no reason for a disabled control, no distinction between `disabled` and
`aria-disabled`, no `[focused]`, no committed value for a custom combobox. ARIA is passed through
faithfully and nothing is derived, so N identically-named siblings are indistinguishable and every
verification step becomes a screenshot. Where ARIA and the DOM property disagree, the tree asserts one
of them with no marker.

**Evidence.**
- `agent-a483801464b3efe0d` (steps 55-80): "`button "Add to cart" [disabled, ref=e9]` with no
  explanation" → ~18 speculative probes; call 61 finally read `title='Please make all required
  selections…'`.
- `agent-a698ef25f69fa3651`: "The selected calendar date is a filled red square in the screenshot and,
  in the tree, just `button "Friday, August 7" [ref=e90]` followed by `StaticText "  "` — no
  [selected], no aria-current".
- `agent-a243326d7ae2dc490`: "'switch [checked=false]' for migration-test-skill while shots/034.png
  shows the toggle unambiguously ON".
- `agent-a467168096ee4d29b`: "'- button "Next" [disabled, ref=e19]' rendered from aria-disabled while
  the DOM disabled property was false — the ambiguity made the agent distrust the snapshot for the
  remaining 110 calls".
- `agent-a090c3f2c60d638f8` (10 screenshots): "Which thumbnail is currently selected — visible as an
  outline in all ten screenshots, absent from the snapshot … so the agent screenshotted after every click".

**Fix.** A state-token pass on every interactive node:
`[pressed|selected|current|checked|expanded|focused|invalid:"…"|disabled:"<title/aria-describedby>"]`,
printing `[aria-disabled]` distinctly from `[disabled]` and both when they disagree. Fall back to
`data-state`/`data-active`/class tokens when ARIA is absent; when ≥2 same-role siblings share an
accessible name and no state token exists, run a computed-style outlier comparison
(background/border/font-weight/outline, `active|selected|current|is-on` class tokens) and emit
`[looks-selected (inferred: .is-active)]`, clearly labelled as inferred. Render the underlying tag when
it differs from the role (`button(div)`, `combobox(input, editable)`).

**Files.** `server.ts:1449-1482` (add the state probe); `snapshot-format.ts`; `tools/browser.ts`
(snapshot description: names are computed, not DOM text).

**Hook.** ≥3 click→screenshot pairs in a session with no intervening snapshot; a snapshot followed by
an eval matching `aria-pressed|aria-selected|classList|getAttribute\('disabled'`; a `[checked=false]`
or `[disabled]` node the agent then successfully clicks; `[expanded=false]` unchanged across two
snapshots straddling a click on that ref.

---

## 8. `scope` is unusable — wrong grammar, duplicated matches, four failure dialects

**≈86/200 sessions · ~190 findings · ~400 wasted · sev 5 · novelty: variant_of_known (`dialog_probe`)
for the role-word case; duplication and abandonment are new**
Fed by: misleading "snapshot scope= fails to match", "nested matches print the same subtree";
snapshot_content SCOPE_DUP, SCOPE_RESOLVE; tool_surface #9, #10; error_message T6; surprises T1, T2.

**Mechanism.** `server.ts:1457` passes `scope` straight through as `-s <css>` with no validation, no
match counting and no containment dedupe. The snapshot prints an ARIA grammar (`dialog "Share"
[ref=e5]`) that `scope` does not accept; a ref is rejected; a comma list either errors when one branch
matches or emits the whole tree once per branch; an ancestor+descendant match prints the same subtree
2–7 times **with identical refs**; a zero match either hard-errors in one of four dialects or silently
returns the full page; a failed scoped snapshot discards `fullText` and can rotate the ref table. The
documented remedy for oversized snapshots is therefore, routinely, the cause of the truncation — and
one or two burns retire the parameter, then the tool, for the rest of the session.

**Evidence.**
- `agent-af765107bb96bcda4` (steps 5, 39): "the 42-cell calendar … and a 20-option select repeated 5x
  in result 5 and 2x in result 39, because every matching element becomes an output root with no
  containment dedupe".
- `agent-a5217606f311ecb40` (step 10): "Error: ✗ Selector 'alertdialog' did not match any element" →
  "fell back to full-page snapshots for the remaining 123 calls".
- `agent-a243326d7ae2dc490` (call 178): "browser_snapshot(scope: '[role="dialog"], .absolute') → '(no
  interactive elements)' while the Share/Collaborate dialog was open".
- `agent-a8721efe020f8459b` (steps 25-83): "call 28 (scope:'body') hung 30s then 'Error: Command
  failed: agent-browser --cdp ws://<redacted> snapshot -i -c -s body'" → abandoned scoping; context
  exhausted on unscoped snapshots + 28 screenshots.
- `agent-a1792dfde131e7843` (step 32): "never called browser_snapshot again; ran the entire 57-call
  session through browser_eval".

**Fix.** Resolve `scope` in-process before dispatch. Run `querySelectorAll` over every comma branch,
drop any match contained by another, emit each node at most once, and prefix
`scope "<sel>" matched 4 elements (2 after removing nested duplicates)`. Accept the grammar the
snapshot prints: `@eN` through the ref registry, a bare ARIA role word retried as `[role="…"]`, a
`role=name` pair, and `@dialog`/`@modal` pseudo-scopes for the topmost overlay. Never error — degrade
to unscoped with `note: scope matched 0 elements — <sel> is not valid CSS / nothing matches;
containers seen: main (12k), [role=dialog] (2k)`, honouring the other options. Detect Playwright-only
syntax (`:has-text(`, `text=`) explicitly, strip stray wrapping quotes, never leak the CDP argv, and
never mutate the ref registry on a failed snapshot.

**Files.** `server.ts:1449-1483`; `snapshot-format.ts` (`capSnapshot` scope hint);
`tools/browser.ts:169-235` (scope description).

**Hook.** Scoped snapshots whose result is an error, is <5 lines, exceeds the previous unscoped
snapshot of the same URL, or repeats a `[ref=eN]` token; then count `scope`-bearing calls in the
remainder of the session (0 ⇒ permanent abandonment) and the `browser_eval` share of remaining calls.

---

## 9. Refs renumber, rebind silently, and fail without provenance

**≈80/200 sessions · ~170 findings · ~500 wasted · sev 5 · novelty: variant_of_known (`stale_ref`) —
that detector sees only the loud `Unknown ref` half; silent rebinding produces no error at all**
Fed by: action_result `ref_identity`; error_message T7; misleading "Ref errors state the symptom";
snapshot_content REFS; tool_surface #4; surprises T15; engine E7; tabs J.

**Mechanism.** Refs are positional and re-issued per snapshot, and resolution is a role+name re-lookup
against the current tree. So (a) the same control gets a different number on every snapshot of an
unchanged page; (b) an in-place re-render, an opened menu, a `back`/`open`/`reload`, a background
`tab close`, or even a *failed* snapshot rotates the table with no digest; (c) a stale ref that still
matches by role+name silently acts on a **different element** and reports success; and (d) when it
does fail, `✗ Unknown ref: e31` carries no snapshot generation, no URL, no valid range and no
"re-snapshot" instruction — even though the click digest already contains that sentence. The prompt
frames staleness as navigation-only, so the model treats refs as an address space and extrapolates
them.

**Evidence.**
- `agent-a83ec31ce1e1dd4dc` (steps 3-39): "The Tasks disclosure button was e28, then e44, then e37,
  then e48, then e39, then e119 across six snapshots".
- `agent-a266cd6b8baa3a558` (call 56): "a stale ref matched a different element by role+name and
  silently navigated to /direct/inbox/ instead of Search — a wrong action reported as success ('Clicked
  e5. Page NAVIGATED')".
- `agent-a9855793c96d8f779` (steps 76-86): the calendar grid re-rendered and `e51` selected Aug 15 2030
  instead of Aug 13 — "None — the agent never noticed. It reported 'Date is set to Aug 15, 2030'".
- `agent-a0253a34760439f6e` (step 16): "✗ Could not locate element with role=button name=upload an
  image" — the snapshot had printed `button "upload animage"`.
- `agent-a243326d7ae2dc490` (14 steps): "'✗ Unknown ref: e576' (also e889, e909, e1368 …)" — fourteen
  invented refs, fourteen recovery snapshots.

**Fix.** Stamp each snapshot with a generation id and store role+name+DOM path with every ref; resolve
by retained handle, never by re-querying role+name; refuse when the identity no longer matches rather
than acting. Error text: `ref e31 is from snapshot #3 taken at <url>; the page re-rendered at call 47
(snapshot #5 is current, refs e1–e123) — take a fresh browser_snapshot`. Validate ref shape first, and
never surface locator-name errors for ref-shaped inputs. Echo the resolved element in every action
result (`Clicked @e85 → button "See more" (2 of 9)`), emit `DOM changed — N refs renumbered` whenever
the registry rotates, and append the stale-refs sentence to `browser_open` and
`browser_run(back|forward|reload|tab close)`. Add `{role,name}` / `{text}` / `{selector}` addressing to
click/fill/type (the CLI's `find` already resolves these) so a ref is not the only handle.

**Files.** `server.ts:1493-1526` (click), `:1529-1564` (fill), `:1424-1492` (snapshot registry);
`browser-digest.ts`; `tools/browser.ts` (ref-taking tools, `Unknown ref` error path);
`web-browser-agent-prompt.md` (state the real lifetime).

**Hook.** Existing `stale_ref`, extended three ways: same accessible name mapping to different ref
tokens across two snapshots of one URL with no navigation digest between; a ref used ≥1 mutating
action after its snapshot whose result carries no error, corroborated by a later re-click of the same
label; ref tokens in tool inputs that never appeared in any prior snapshot (invented, not stale).

---

## 10. `browser_wait` — one mode, cannot fail, cannot pace

**≈74/200 sessions · ~140 findings · ~380 wasted · sev 5 · novelty: variant_of_known (`wait_timeout`)
for the timeout half; the 0 ms "satisfied" and escalating-sleep halves are new**
Fed by: wait_timing A, B, C, E, F; misleading "browser_wait reports 'satisfied'"; error_message T8;
tool_surface #17; surprises T3.

**Mechanism.** `browserWaitTool` exposes one field, `for: string`, described as a CSS selector and
spending the rest of its words forbidding load states — while the CLI underneath supports
`wait <selector|ms|--text|--url|--load|--fn>`. The server discards everything the CLI returns on
success and prints a constant `Wait condition "X" satisfied.` with no elapsed time, so `body`/`img`/
`h1` resolve at t≈0 and read as a real wait; agents used it as the sleep primitive the harness lacks
(19×, 102× in single sessions) while believing they were throttling. The failure path is equally
blind: no validation, so Playwright syntax burns the full 25 s, and `✗ Wait timed out after 25000ms`
reads as a fact about the page — with no URL, readyState, match count or near-miss.

**Evidence.**
- `agent-a64d4ab166234ea3c` (102 calls): "used a tool that does nothing 102 times, saying 'let me wait
  longer' after each one … The harness never once said 'this didn't wait'".
- `agent-ae20a4ddb9653e009` (steps 2,4,6,…,38): "'Wait condition "body" satisfied.' — technically true,
  functionally a lie; it resolved in 0ms and the agent believed its rate-limit mitigation was in effect
  when it was not".
- `agent-a6369ec091fc4db8a` (steps 98,115,143,…,331): "repeated `text=Trigger` nine times across three
  hours, treating the 25s failure as a sleep primitive" — 16 of 16 calls failed.
- `agent-a7f5479e75bf970f0` (steps 163-366): "12 x '✗ Wait timed out after 25000ms' (~5 min) with no
  mention that the tab was at about:blank".
- `agent-abfc323128ff2194f` (steps 47-92): "browser_run(["wait","2000"]) then 3000, 4000, 5000, 8000,
  screenshotting after each".

**Fix.** Widen the schema to `{for?, ms?, text?, textGone?, url?, fn?, ref?, settled?, timeoutMs?}` and
pass the matching CLI flag; accept `@eN` and `role=name`. Validate `for` as CSS in <50 ms and reject
`text=`/`:has-text(`/role words naming the right mode; refuse `body`/`html`/`*`. Time every call:
render `satisfied after 0 ms — the selector already matched; this did not delay anything` for
pre-matches, and on timeout append URL, `document.readyState`, whether the page navigated during the
wait, and per-clause match counts. Add `settled:true` (DOM mutations and in-flight requests quiet for
N ms, with a `stableCount` variant for lazily-growing lists) — the one primitive that retires the
sleep-and-look loop. Reject an over-cap duration immediately instead of burning the 30 s exec ceiling,
and let `timeoutMs` raise that ceiling.

**Files.** `tools/browser.ts:322-341`; `server.ts:1607-1647` (wait), `:875-908` (the 30 s exec cap);
`web-browser-agent-prompt.md`.

**Hook.** `browser_wait` results matching `satisfied` with wall-clock <250 ms, or whose `for` is in
{body, html, *, a, img, h1, div, main}; `browser_wait` inputs matching `^(text|role|id)=|:has-text\(`;
timeouts with duration ≥20 s bucketed by selector class; runs of ≥2 non-decreasing sleeps
(`browser_run` `wait <digits>` or eval `setTimeout`) separated by observations at the same URL.

---

## 11. The cross-origin iframe footer misclassifies frames and preaches payment on every page

**≈70/200 sessions · ~130 findings · ~170 wasted · sev 5 · novelty: new**
Fed by: misleading "Cross-origin iframe footer"; snapshot_content FRAMEFOOTER; surprises T18;
prompt_guidance #7; error_message T11; tool_surface #20; tabs I; other T9.

**Mechanism.** `IFRAME_ENUM_SCRIPT` decides same-origin with `try { f.contentDocument }`, which throws
or returns falsy for frames that *are* merged into the tree (not yet loaded, sandboxed), so
`formatIframePlaceholders` prints "contents NOT in this snapshot (cross-origin)" directly beneath that
frame's own contents with working refs — sometimes twice for one frame, sometimes for a frame on the
page's own host. The footer then appends a Stripe-card recipe unconditionally, on reCAPTCHA, cookie,
ad, chat and telemetry frames, and the coordinate click it prescribes does not exist
(`Unknown subcommand: click`). The enumerator has `f.src` and discards everything but the host, so a
frame's URL, id and box are unavailable, and `browser_run("frame <sel>")` — the thing that would work —
is never named. Agents believe the prose over the tree and record "not inspectable" in compaction summaries.

**Evidence.**
- `agent-a9e3beaf5b6f0e5a4` (steps 64-71): "The snapshot listed the iframe's buttons with usable refs
  (e50, e51, e52) and then said 'iframe … contents NOT in this snapshot (cross-origin)'" → tried JS,
  then raw mouse coordinates, then finally @e50, which worked.
- `agent-a6e5112a7764cf052` (call 39): "'iframe "Field container for: Card number"
  (checkout.pci.shopifyinc.com) - contents NOT in this snapshot' printed directly under a tree that
  listed textbox "Card number" [ref=e488] inside that very frame".
- `agent-ae454d50a96b7fe47` (115 snapshots): "the frames footer … instructs the model to 'click into it
  by coordinates' while `mouse click x y` is rejected as an unknown subcommand".
- `agent-a75379256dba80178` (steps 1,4,6,…,25): "~60 lines of credit-card advice in a Gmail read task".
- `agent-a26d38e9b30ea72b3` (call 19, ~100 calls steered): "the agent's single wrongest belief ('the
  iframe is cross-origin') was harness-induced … one frame-inventory command would have killed it".

**Fix.** In `IFRAME_ENUM_SCRIPT`, keep `f.src` (origin+path, ≤120 chars), an id/stable selector and
`getBoundingClientRect()`, and compare `new URL(f.src).origin` with `location.origin`. Suppress the
placeholder entirely when that frame's nodes already appear in the emitted tree. Gate the fill recipe
on the frame plausibly holding inputs (payment-host allowlist or an input-count probe) and rewrite it
to name commands that exist: `browser_run(["frame","<sel>"])`, or the new `browser_click({x,y})` with
the frame's rect. Fold ad/telemetry frames into `+N tracking frames`. Make `Frame not found`
distinguish "no such frame" from "cross-origin — cannot be entered; its box is x,y,w,h".

**Files.** `snapshot-format.ts` (`IFRAME_ENUM_SCRIPT`, `parseIframeInfo`, `formatIframePlaceholders`);
`server.ts:1466-1482`; `tools/browser.ts:527, 543` (the matching payment sentences).

**Hook.** Snapshot results containing `contents NOT in this snapshot` where the named host equals the
page host **or** the same body contains a ref line under that frame; sessions where the payment
sentence appears but no fill/type ever targets a frame; `mouse click`/coordinate attempts within 3
calls of a footer; `browser_eval` matching `querySelectorAll\(['"]iframe` within 5 calls of one.

---

## 12. Repeated-record structure is destroyed — rows, cards and tables arrive as flat control lists

**≈66/200 sessions · ~95 findings · ~290 wasted · sev 5 · novelty: covered_by_known_detector
(`eval_for_extraction`) for the workaround; the structural cause is new**
Fed by: snapshot_content RECORD; snapshot_vs_screenshot T8; tool_surface #8.

**Mechanism.** The compact filter loses DOM containment in both directions. Search results, listing
cards, tables, directories, settings rows and kanban columns come back as a flat sibling run of
controls whose names are identical (`Add`, `-`, `+`, `done/snooze/dismiss`) or bare titles, with every
field the task wants (price, rating, date, status, row label) dropped or unattached; empty cells are
dropped so column position silently shifts. Meanwhile container nodes collapse the other way, jamming
a whole subtree into one undelimited name (`"10.6K255Pinned post iconView Count Icon2M"`). The
universal workaround is a bespoke `browser_eval` scraper per site — the single most common escape
hatch in the corpus — whose silent mistakes cost correctness, not just calls.

**Evidence.**
- `agent-a96647e032eb9726b`: "a 3-column change-history table … is flattened into a bare list of `cell`
  nodes with empty cells dropped, so rows arriving with only two cells … cannot be assigned to a column
  — a silent correctness hazard".
- `agent-a3eae015eb4537753` (steps 1-31): "110 consecutive 'button "-"' / 'button "+"' pairs with only
  the section heading to go on" → wrote a `findRowByLabel()` mapper in eval and did all 30+
  interactions in JS.
- `agent-a460db7e5e5c23194` (steps 6-81): "abandoned browser_snapshot entirely after call 1 and rebuilt
  extraction in JavaScript" — 70 of 81 calls were eval.
- `agent-aab5124c37e1b0f7a` (steps 72-91): "`link "Condo in Princeville" [ref=e13]` and nothing else"
  against a screenshot showing beds, price and rating → seven eval scrapes.
- `agent-a01ffebf2ef9f3e85`: "Tile text arrives concatenated — '10.6K255Pinned post iconView Count
  Icon2M' — likes/comments/pin/views run together with no element boundary".

**Fix.** Two halves. (a) In compact mode preserve one level of container identity: emit one line per
repeated block — `row 3: Condo in Princeville | 2 beds | $312/night | 4.91 [controls: @e13 @e14]` —
keep empty cells as `""` placeholders so column position survives, and join concatenated descendant
text with an explicit ` · ` separator. (b) Add `browser_extract({scope|rowSelector, fields?, limit,
cursor})` returning one deduped record per repeated element with its visible text, href and per-row
refs; the CLI's `--json` snapshot already carries the tree shape needed.

**Files.** `server.ts:1453` (`-c`), `:1424-1490`; `snapshot-format.ts`; new tool in `tools/browser.ts`
+ route in `server.ts`.

**Hook.** Snapshots with >50 consecutive `cell`/`button` lines at one indent with no `row`/`table`
ancestor; ≥2 `browser_eval` calls per session matching
`querySelectorAll\(.*\)\s*\.map|\[\.\.\.document\.querySelectorAll` returning >500 chars within 5 calls
of a snapshot of the same URL; bonus signal when ≥2 of them return `[]` before one succeeds.

---

## 13. Unnamed and mis-named controls — no fallback chain, placeholders as labels

**≈62/200 sessions · ~87 findings · ~150 wasted · sev 5 · novelty: new**
Fed by: snapshot_vs_screenshot T6; snapshot_content NAMEFALLBACK, NAMEHYGIENE (clipping half).

**Mechanism.** When the computed accessible name is empty the serializer prints `generic [ref=e50]
clickable` or `button [ref=e57]` and discards everything else the DOM has: `title`, a child
`svg[aria-label]`, `alt`, `data-testid`, `id`, `href`, the icon class, the nearest preceding visible
text. Icon fonts pass through as private-use codepoints. Where a visible `<label>` is not associated
via `for`/`aria-labelledby`, the field is named by its **placeholder example text** — actively
misleading. Indistinguishable siblings then get clicked at random; one session mutated the user's
workspace, another filed a false accessibility bug against the app under test.

**Evidence.**
- `agent-a8e5dcb5eb889d4be` (steps 41-173): "five indistinguishable controls in the tree: `generic
  [ref=e50] clickable`, … `button [ref=e57]`, … no names, and the only tell (disabled) …" → 9 misclicks
  including an unwanted account artifact.
- `agent-a31c9b9c5b27ec7ff` (shot 002): "every Offer-form field has a visible left-hand label … rendered
  as a sibling div, not associated via label/for … so the tree shows textbox "undefined" and spinbutton
  "Example: 3"".
- `agent-aae7d24d2a8bf646e` (steps 5-10): "`button "󱱸"` (search magnifier) and `button "󱩂"` (filter) as
  private-use-area font glyphs" → abandoned the snapshot at call 22.
- `agent-a53b7113b96cd4309`: "`- button ""` × ~350 were a private-use icon-font codepoint passed through
  verbatim while `title="hide posting"` sat unused — a name-resolution fallback gap".
- `agent-a88fffbc8116dd78c` (steps 77-136): "`DisclosureTriangle "Review contextual evidence"
  [expanded=false]` with no ref. The element is a native `<summary>` with tabIndex 0 and aria-label".

**Fix.** A documented fallback chain when the computed name is empty — `aria-label` → descendant
`svg[aria-label]`/`<title>` → `title` → child `img[alt]` → nearest preceding visible text in the same
block → `data-testid` → `name`/`id` → `href` basename → `placeholder` — with the source in brackets
(`button "close" [from class]`). Mark placeholder-derived names (`textbox "Summary of unread mail"
[name from placeholder]`) and include the nearest visible label. Give every focusable node
(`<summary>`, `tabIndex>=0`) a ref. Map private-use glyphs to `title`/`aria-label` rather than emitting
them. Collapse runs of >20 unnamed same-role controls to reclaim tokens.

**Files.** `snapshot-format.ts` (needs an attribute probe alongside the iframe enumeration), or
upstream in the CLI serializer; `server.ts:1449-1458`.

**Hook.** Count `^\s*-\s*(generic|button|link)\s*\[ref=` lines with no quoted name per snapshot; flag
>20% of refs; correlate with subsequent invented-ref errors, `get attr` calls, coordinate clicks,
`annotate:true` screenshots, or repeat clicks on adjacent refs.

---

## 14. The NAVIGATED verdict is a racy string compare

**≈61/200 sessions · ~93 findings · ~180 wasted · sev 5 · novelty: new**
Fed by: action_result `digest_timing`, `false_navigated`; misleading "The NAVIGATED verdict is computed
from a single racy URL read"; error_message unclustered (pre-redirect hop).

**Mechanism.** `/browser/click` sleeps a flat `CLICK_SETTLE_MS = 300` and then reads `get url`;
`observeUrl` compares that string to the last observation. Client-side routers commit later, so the
sampled URL is often the previous one — the digest says "URL unchanged" for a click that navigated and
then "Page NAVIGATED — now at <the page you just left>" on the following action, poisoning the next
comparison too. In the other direction, `?variant=`, a fragment, a trailing slash, a reordered query or
a same-URL `pushState` all trip `Page NAVIGATED … Refs from previous snapshots are stale`, so the agent
obediently re-snapshots a 752-line country list whose ref table never changed. Redirect hops are
reported as the landing URL.

**Evidence.**
- `agent-a3dcd187d3e6b6d0c` (call 2): "'Clicked e4. Page NAVIGATED - now at
  https://ebam-atlas.vercel.app/' - asserts navigation while printing the pre-click URL; real
  destination was /investments/portfolio".
- `agent-a6e5112a7764cf052` (steps 12-77): "*Page NAVIGATED — now at ...?variant=45255418577065. Refs
  from previous snapshots are stale*" on a Shopify pushState; snapshots at calls 50/54/57/60/63/67/77
  are byte-identical (e59-e68 every time).
- `agent-a243326d7ae2dc490`: "'Pressed "Escape". Page NAVIGATED - now at https://manus.im/app.' when the
  URL before the press was already https://manus.im/app".
- `agent-ad1e4171e5f4353d0` (steps 40-41): "*Clicked e11. URL unchanged (…/share/488762ea…/)*" when the
  page had routed to `…/view/29ebf1f7…`; ~19 verification-only calls followed.
- `agent-a94e648fb43046a0b` (steps 7-33): "'URL unchanged (https://www.redfin.com/)' … while the tab was
  on apps.mptsweb.com".

**Fix.** Derive navigation from an actual document commit — a `frameNavigated` event or a document
identity token — not a string diff, and replace the fixed sleep with a settle (navigation event +
`requestAnimationFrame` flush, or poll `location.href` to stability with a short deadline); when still
in flight, say "navigation may still be in flight" rather than asserting a URL. For same-document URL
edits emit `URL updated (same document) — refs still valid`; never print NAVIGATED when the string is
unchanged; report `navigated X → Y (1 redirect)` from the settled URL; tie the stale-refs sentence to
the registry actually rotating (theme 9).

**Files.** `browser-digest.ts:21-25` (`CLICK_SETTLE_MS`, `PRESS_ENTER_SETTLE_MS`), `:40-77`
(`observeUrl`, `formatUrlDigest`); `server.ts:1516-1521`, `:1650-1690`, `observeUrlDigest` ~`:910`.

**Hook.** `Page NAVIGATED — now at X` where X equals the previously reported URL, or differs only in
fragment / query order / percent-encoding / trailing slash; `URL unchanged (X)` or `NAVIGATED … X`
where the next result reports a URL ≠ X with no intervening navigation action; NAVIGATED results whose
following snapshot has an unchanged ref set.

---

## 15. Browser death and launch failure reach the model as vendor plumbing

**≈58/200 sessions · ~90 findings · ~700 wasted · sev 5 · novelty: new**
Fed by: error_message T2, T9, T10, T15; misleading "When the browser dies", "'--profile ignored'";
engine E2, E3, E12; auth_or_blocker T1, T2; surprises T22; prompt_guidance #5.

**Mechanism.** A dead CDP session, a crashed tab, a reaped daemon and a provider refusal reach the
model as one of several unrelated strings — `✗ Auto-launch failed: CDP WebSocket connect failed: HTTP
error: 410 Gone`, the two-word `Browser is not active` (returned from 16 sites in `server.ts` with no
remedy clause), `Failed to launch host browser: {"error":…"billing_past_due"…}`, or
`⚠ --profile ignored: daemon already running. Use 'agent-browser close' first` — a warning promoted to
an error whose remedy the prompt forbids in capitals and for which the agent believes it has no tool.
None says what changed (tabs closed, page state and window globals gone, ids reassigned), whether it is
transient, that `browser_open` is the recovery, or that `location="container"` exists. So the specialist
quietly becomes a web-search agent and ships a confidently formatted report about pages it never opened.

**Evidence.**
- `agent-a933a4eb988ae190a` (steps 23-40): "18 blind retries across snapshot/screenshot/reload/get_state/
  get url/open/wait over ~10 minutes, until call 40 finally showed '✗ Auto-launch failed: … 410 Gone'".
- `agent-a097123cf81ad31c5` (steps 1,10): "`Error: Failed to launch host browser: {"error":"Failed to
  create platform Browserbase context: 402 … \"type\": \"billing_past_due\" …"}`" → 70 further WebSearch
  calls reconstructing a 100-row table from search summaries.
- `agent-a9be0ad4637be958f` (step 3): "ran 83 WebSearch calls instead and wrote a report that never
  mentions the browser was down".
- `agent-a6a27b77aee79fd26` (step 3): "abandoned the browser entirely after one call … never tried
  location=\"container\"".
- `agent-a5a2b5764d5c93cb1`: "'Auto-launch failed: CDP WebSocket connect failed: HTTP error: 410 Gone' —
  implementation detail as guidance; it induced the false belief that clicking too fast crashes the browser".

**Fix.** One `classifyBrowserFailure()` between `execBrowser` and the routes: probe the target list on
any non-zero exit and map to `BROWSER_DEAD` / `TARGET_CRASHED` / `CDP_TIMEOUT` / `PROVIDER_BILLING` /
`PROVIDER_UNREACHABLE` / `LAUNCH_RACE`, each with one fixed sentence — "The browser session ended
(cookies and logins preserved; page state and refs are gone). Reopen with `browser_open("<last url>")`."
Attempt one transparent reconnect + reopen of the last URL on `TARGET_CRASHED`; auto-retry a public URL
in bundled Chromium on a provider failure and say what did not carry over; give all 16 `Browser is not
active` sites the `browser-download.ts:315` wording; filter `--profile ignored` and any
`agent-browser close` advice out of agent-visible text. Return a structured `BROWSER_UNAVAILABLE`
result the subagent must propagate ("you may not report browsed content; say so to the parent"), keep a
per-session consecutive-failure budget that stops the retry churn, and mark a subagent result when zero
browser calls ever succeeded.

**Files.** `server.ts:875-908` (`execBrowser`), the 16 `Browser is not active` guards,
`launchHostBrowserIfNeeded` ~`:1008`, `/browser/open` `:1240-1305`; `browser-liveness.ts`;
`browser-location.ts`; `browser-output.ts` (stderr filter beside `redactCdpUrls`);
`tools/browser.ts` (`errorResult`, `browserGetStateTool`); `web-browser-agent-prompt.md` (recovery +
disclosure rules).

**Hook.** Runs of ≥2 consecutive results matching
`Command failed: agent-browser|Browser is not active|410 Gone|Auto-launch failed|billing_past_due|--profile ignored`,
scored by the length of the run before the next successful `browser_open`; sessions where `web_search`
calls exceed successful browser calls; sessions with zero successful browser results whose final
message contains per-source extraction claims.

---

## 16. Scroll acts on the window, and the digest measures the window

**≈56/200 sessions · ~105 findings · ~300 wasted · sev 5 · novelty: new**
Fed by: action_result `scroll_wrong_scroller`; misleading "The scroll digest measures the window";
tool_surface #13; snapshot_vs_screenshot T12; surprises T5; snapshot_content LOADING (virtualization half).

**Mechanism.** `/browser/scroll` probes exactly
`{y: window.scrollY, vh: window.innerHeight, h: document.documentElement.scrollHeight}`
(`server.ts:1594`) and `formatScrollDigest` renders it in confident position language. On any app-shell
layout — an `overflow-y-auto` results pane, a docs root, a modal with scroll lock — the window is
unscrollable, so the tool no-ops and the digest asserts "Viewport now shows 1–860 of 860px (bottom of
page)". Horizontal scrolls are reported with vertical numbers. `browser_scroll` takes no target, there
is no absolute scroll and no scroll-to-element, and nothing anywhere reports that a region is
virtualized or how many rows exist versus render. Reviewers note the digest is *excellent* on plain
documents, which is exactly what makes the failure case dangerous.

**Evidence.**
- `agent-a3e8c7a56b20e6e47` (steps 24-50): "*Scrolled down by 3000px. Viewport now shows 1-860 of 860px
  (bottom of page).*" while the list lived in `div.overflow-y-auto` (scrollHeight 4738, clientHeight 688).
- `agent-a7b123f1ecc26fe5e` (calls 6, 7, 95): "nothing scrolled, and the real scroller is 40,087px tall
  in a 671px viewport"; the agent hand-rolled ~50 `.doc-root` scrollTop assignments.
- `agent-a3dcd187d3e6b6d0c` (calls 12, 104, 175): "'Scrolled right by 400px. Viewport now shows 0–720 of
  884px (top of page)' - vertical viewport reported for a horizontal scroll".
- `agent-a5a2b5764d5c93cb1` (steps 11-292): "`Scrolled down by 400px.` — while screenshots 003 and 004
  are byte-identical (md5 71cbcd50…)"; abandoned the tool for 280 calls.
- `agent-af878677f8cb9aee1`: "no virtualization/'25 of 237' signal anywhere in the tree; an agent
  trusting the snapshot would have reported 25 stores".

**Fix.** `browser_scroll({ref|selector, to: px|'top'|'bottom'|ref, direction, amount})` that walks to
the nearest scrollable ancestor (or the deepest scrollable container under the viewport centre), scrolls
*that*, and reports the element that actually moved with measured before/after offsets on the correct
axis — leading with `nothing moved — the window is not scrollable here; the scrollable region is
<main.results> (scrollTop 30479/40087)`. Extend the probe to enumerate elements with
`scrollHeight > clientHeight + 8` and list them in the snapshot footer, and report
`container renders 25 of ~237 items` for windowed lists.

**Files.** `server.ts:1567-1605` (the hardcoded `window.scrollY` probe); `browser-digest.ts`
(`parseScrollInfo`, `formatScrollDigest`); `tools/browser.ts:289-320`.

**Hook.** Consecutive `browser_scroll` results whose `Viewport now shows A–B of T` is identical, or
where `y === 0 && pageHeight === viewportHeight`, or where direction ∈ {left,right} and the digest
prints a vertical range; any scroll followed within 3 calls by an eval matching
`scrollHeight|scrollTop|overflow|scrollIntoView`.

---

## 17. No page or tab provenance — one browser, many sessions

**≈55/200 sessions · ~100 findings · ~730 wasted · sev 5 · novelty: new (`tab_churn` counts
proliferation, not desync or false-reuse)**
Fed by: engine E1, E4, E5; tabs A, B, C, E, H; misleading "Tab bookkeeping asserts events that did not
happen"; surprises T6.

**Mechanism.** The container holds one `browserState` record and an advisory, transferable lock, and
`tabManager.queryTabs()` talks to a shared daemon socket with a shared profile — so concurrent
subagents and earlier tasks drive the same tabs. No tool result names the tab id or the committed URL
it acted against; `browser_open` resolves a tab and prints its id, while `/browser/eval`,
`/browser/snapshot`, `/browser/screenshot` and `/browser/click` each re-exec against whatever the
daemon considers active (`selectActivePageTarget()` falls back to `targets[0]`). Tab bookkeeping has
two sources of truth: a cached `lastKnownTabCount` feeding the footer versus the live listing, and
`detectNewTab()` compares counts rather than diffing id sets, so a read-only `browser_run("tab")`
answers "New tab opened — you are now on tab t1".

**Evidence.**
- `agent-a6782999a4db49a0e` (call 52): "The search field literally read 'Airsplashpluot' at call 52 —
  two concurrent sessions' keystrokes interleaved into a single input, reported by the harness as a
  perfectly ordinary snapshot value".
- `agent-a30cabe8199f80037` (steps 11-89): "Switched to existing tab t2 which already has
  .../afro-house/89/top-100 open" while eval returned tech-house content → ~75 calls defending a false
  "Beatport has an infinite-scroll genre sidebar that rewrites the URL" theory.
- `agent-a13d99af214b8c35e` (steps 13-95): "three consecutive browser_open of the SAME f.io short link
  land on three different shares"; a tab labelled 'work' it never created appeared as t3.
- `agent-ad4e93485d2679bea` (steps 34-52): snapshot footer "[Tabs: 3 open]" vs `browser_run('tab')`
  listing one tab two calls later; "Cannot close the last tab" two calls after a two-tab listing.
- `agent-a64d4ab166234ea3c` (step 236): "a read-only listing answered with 'New tab opened — you are now
  on tab t1 (...). 2 tab(s) open.'" → the agent then spent two calls switching and closing tabs.

**Fix.** Give each session its own browser context (or a leased tab other sessions cannot switch away
from); until then, resolve the page target **once** per tool call, pin every sub-call to it, and stamp
every browser result with `[t2] <committed url>`. When the active target's URL changed without this
session navigating, prefix the next result: `⚠ the page changed underneath you (was X, now Y — another
actor navigated this tab); refs from previous snapshots are void`. Drop `lastKnownTabCount` in favour
of the live listing for both the footer and `tab`; diff tab **id sets** in `detectNewTab`, name the id
that is actually new, wait for its first committed navigation before printing a URL, suppress
notifications on read-only `tab` commands, emit an explicit "browser relaunched — tab ids were
reassigned" event, and never print bare integer ids.

**Files.** `browser-state.ts` (`validateBrowserSessionWithRecovery`, `server.ts:797`);
`active-page-target.ts`; `tab-manager.ts` (`lastKnownTabCount`, `detectNewTab`, `formatTabNotification`,
`formatTabStatus`); `server.ts` `/browser/{open,eval,snapshot,screenshot,run}`; `browser-digest.ts`
(module-global `lastKnownUrl`).

**Hook.** Consecutive observations whose URLs differ with no intervening `browser_open`/back/forward/
click-navigation; any `tab` listing containing ids or labels this session never created; `[Tabs: N
open]` disagreeing with the nearest listing within 5 calls; `New tab opened` on a bare `tab` command or
announcing `about:blank` or the id the session was already on; a fill read-back returning text this
session never sent.

---

## 18. Pixel space is undisclosed and there is no coordinate click

**≈55/200 sessions · ~90 findings · ~430 wasted · sev 5 · novelty: new**
Fed by: snapshot_content SHOT; action_result `screenshot_viewport`, `coordinate_space`;
snapshot_vs_screenshot T11; tool_surface #3, #15; surprises T14; engine E10; other T8.

**Mechanism.** `resizeScreenshot` clamps to 1568 px / 1.2 MP and returns a `resized` flag that
`tools/browser.ts:60` discards, so the model sees a 1461×822 image of a 2560×1440 CSS viewport with no
size, no scale and no statement that `mouse move x y` takes CSS pixels — a 1.752× error on every
coordinate. Three separate places *instruct* the model to click by pixel (browser_type's description,
browser_snapshot's description, the iframe footer) while the CLI has no `mouse click`: the model gets
`Unknown subcommand: click`, then pays three calls (`move`/`down`/`up`) each returning a bare `✓ Done`.
`get box` returns document-relative coordinates with no frame named. Screenshots land in a janitor-swept
tmp dir with no `path`/`clip`/`scale` params, `full:true` ignores an emulated viewport and composites
sticky chrome mid-page, and nothing budgets accumulated images.

**Evidence.**
- `agent-ac321a549db26daa2` (steps 85-165): "screenshots at 1461x822 with no dimensions or scale, while
  browser_run('mouse move x y') takes CSS px in a 2560x1440 viewport (1.752x mismatch, only discovered
  via browser_eval at call 119)" → ~30 blind ping-pongs; at call 165 "38 full-size 1461x822 screenshots
  accumulated with no warning, then 'Request too large (max 32MB)'".
- `agent-a83ec31ce1e1dd4dc` (step 27): "`Error: Unknown subcommand: click / Valid options: move, down,
  up, wheel`".
- `agent-aae7d24d2a8bf646e` (steps 12-104): "8 clicks × 3 calls = 24 calls, each of the three returning
  only '✓ Done'" — on a task that had handed it working CSS selectors.
- `agent-a76edacff87396fb2` (steps 19-40): "Both coordinate clicks landed outside the modal and
  dismissed it", with no viewport size or image scale stated anywhere.
- `agent-afd67bb54a34cc498` (9 coordinate calls): "derived the screenshot downscale factor by hand
  mid-task from window.innerWidth (computing 1.758 against an actual 1.752)".

**Fix.** Print the transform on every screenshot / get_state result: `viewport 2560×1440 · image
1461×822 · scale 0.571 (multiply image coords by 1.752 for mouse commands) · refs unchanged since your
last snapshot (e1–e112)`. Add `browser_click({x, y})` (and a CLI `mouse click`) that moves, settles,
clicks, names the element under the point and returns the standard digest. Give `browser_screenshot`
`path`/`filename`, `ref`/`clip` and `scale`, default the destination under `/workspace/downloads/`,
honour the emulated viewport in full-page capture, warn when the downscale drops below ~0.5, and return
tall pages as viewport-resolution tiles with offsets. Have `get box` return viewport-relative
coordinates (or both, labelled) plus `inViewport`. Track cumulative image bytes per session and emit a
budget line before the request cap.

**Files.** `tools/browser.ts:54-66`, `:371-413` (screenshot), `:578-633` (`browser_run` docs),
`:635-690` (get_state); `image-utils.ts` (`MAX_DIMENSION` 1568 / `MAX_PIXELS` 1.2M, the discarded
`resized`); `server.ts:1693-1726`, `/browser/run` mouse + `get box`; `cdp-editing-commands.ts`;
`screenshot-janitor.ts`.

**Hook.** Any `browser_run` `mouse move|down` within 3 calls after a screenshot, followed by another
screenshot with no state change; `browser_eval` reading `innerWidth|devicePixelRatio|
getBoundingClientRect` within 3 calls of a screenshot; results matching `Unknown subcommand: click`;
consecutive `mouse move`→`down`→`up` triples; per-session screenshot bytes vs the request cap; final
messages containing `/home/claude/.agent-browser/tmp/screenshots/`.

---

## 19. Contentless success strings, and a digest on only two verbs

**≈55/200 sessions · ~130 findings · ~190 wasted · sev 5 · novelty: new**
Fed by: misleading "Non-digest tools echo the request"; action_result `digest_coverage`,
`diag_no_output`; error_message T4; tool_surface #23; surprises T9.

**Mechanism.** `tools/browser.ts:620` renders `data.output ? String(data.output) : 'Command executed.'`,
so `console`, `errors`, `cookies`, `get value`, `get attr` and `network requests` answer with a success
acknowledgment when they return nothing — a string that cannot be distinguished from "no console
errors", "capture was never armed", "unsupported subcommand" or "output swallowed". Three separate
sessions laundered it into a QA verdict. Meanwhile only click and press carry a digest:
`browser_run` (back/forward/reload/find-click/check/mouse), `browser_open`, `browser_upload`,
`browser_eval`, `browser_scroll` and `browser_screenshot` return `✓ Done`, a bare URL or a path — no
page identity, no navigation flag, no stale-refs warning, though `back`/`open`/`reload` silently poison
every ref.

**Evidence.**
- `agent-a4a87055b788c1028` (steps 3-52): "the literal string \"Command executed.\" six times"; the final
  report claimed "No console errors were logged … browser_run(\"errors\") returned clean at every check".
- `agent-a3a9028a5319f28a3` (steps 2-75): "hedged in-thought … and then reported goal 20 as PASS: 'No JS
  errors were captured at any point in this session'".
- `agent-a2e533156f32a798a` (steps 67-68): "\"✓ Done\" with no geometry at all" → "never used the get*
  family again for the rest of the session".
- `agent-aab5124c37e1b0f7a` (steps 11-47): "every browser_run mouse primitive returned bare '✓ Done'"
  while screenshots 002-012 are pixel-identical — four drags and a wheel zoom moved the map zero pixels.
- `agent-a266cd6b8baa3a558`: "browser_run(\"back\") returns a bare URL line and browser_open returns
  'Browser opened and navigating to X' — neither says 'refs are stale'" → four `Unknown ref` errors, then
  a stale ref matched a different element by name and navigated to `/direct/inbox/`.
- `agent-aaa72aa0e5faf8bc2` (step 158): "*✓ Request log cleared*" as the confirmation for
  `storage local clear`.

**Fix.** Never let a read verb fall through to the generic acknowledgment: per-verb empty rendering —
`console → (no messages captured since page load at <t>)`, `errors → (none recorded)`,
`requests → (recording not armed — run "network route <pattern>" then reload)`,
`get attr → (attribute "title" not present)`, eval `"" → "" (empty string)`. Compute the digest in the
shared `/browser/*` layer (or in `execBrowser`) so every mutating command carries the same
URL + navigation + refs-stale + change lines, and append page identity to read-only results. Make each
confirmation come from the command that actually ran, and point `browser_hover` at `browser_screenshot`
rather than at a snapshot that cannot show a tooltip.

**Files.** `tools/browser.ts:613-633` (the `'Command executed.'` fallback), `browserHoverTool`,
`browserUploadTool`; `server.ts:1951+` (`/browser/run`), `/browser/open`, `/browser/upload`;
`browser-digest.ts` (reuse `formatUrlDigest`).

**Hook.** Results whose entire body matches `^(✓ Done|Command executed\.|Hovered over @?e\d+\.|
Screenshot saved to: )` followed within 2 calls by a location/state probe; `browser_run` read verbs
answering exactly `Command executed.`, correlated with a final message asserting an absence ("no
errors", "clean", "PASS"); `browser_run(reload|back|forward)` with no stale-ref text followed by an
`Unknown ref` within 5 calls.

---

## 20. No geometry and no graphics census

**≈50/200 sessions · ~210 findings · ~210 wasted · sev 5 · novelty: new**
Fed by: snapshot_vs_screenshot T2, T9; snapshot_content GEOM; tool_surface #24.

**Mechanism.** `[ref=eNN]` says nothing about where or whether the element is: a ref 800 px below the
fold, one clipped by overflow, a hover-reveal control, a `display:none` subtree and a zero-area carousel
all serialize identically, so every click gambles on viewport position and "is this clipped / offscreen /
scrollable / responsive-broken" costs a bespoke eval. The tree is byte-identical at 1440 px and 390 px.
Symmetrically, pages painted rather than marked up — canvases, maps, D3/SVG charts, node-graph editors,
product photos, PDFs in a viewer — produce a small, well-formed tree that is silently empty of the
answer, with no "this page is canvas-dominant" marker; SVG `<text>` labels and `img src` never appear.

**Evidence.**
- `agent-ad83ec7c7e5e85dc6`: "below-the-fold-ness itself is unexpressible: an on-screen ref and one 800px
  down render identically as [ref=eNN], so every click gambles on viewport position".
- `agent-a2e533156f32a798a` (shots/012): "region "Carousel slides" [ref=e35] has 48 children and zero
  indication it occupies no visible area … The snapshot asserted the opposite of the bug".
- `agent-a6369ec091fc4db8a` (steps 266-365): "a flat node list with no edges, plus 18 unattached `button
  "True"` / `button "False"` siblings at the end of the tree" → 60 wasted calls.
- `agent-a7834ea87f5ad683e` (steps 21-28): "Eight browser_eval calls: probed .react-flow__edge (0),
  dumped 452 svg path `d` attributes, then found `[data-id]` and got 41 edges + 23 nodes in one shot".
- `agent-a933a4eb988ae190a`: "the entire content of the task — nine brand pages of campaign artwork — is
  canvas-rendered and absent from the tree … no warning anywhere that the tree is near-empty because the
  page is canvas-dominant".

**Fix.** One `getBoundingClientRect` sweep behind `browser_snapshot({includeBox:true})` (mirroring
`includeUrls`) emitting `x,y,w,h` per ref plus `[offscreen ↓1200px]`, `[clipped]`, `[0×0]`,
`[not painted]`, and a viewport/scroll header line. Add a graphics census beside `IFRAME_ENUM_SCRIPT`:
list `<canvas>`/`<svg>`/large `<img>` with rect and % of viewport covered, inline `svg text` content,
emit `img src` + natural size, and when painted elements cover >40% of the viewport append the same
hard warning the iframe footer gives — "this page is canvas-dominant — the tree cannot see it;
screenshot instead". Add `browser_inspect(ref, props?)` for box, computed styles, occlusion and
`title`/`aria-describedby` text.

**Files.** `server.ts:1449-1482` (probe); `snapshot-format.ts`; `tools/browser.ts` (snapshot flags,
`browserHoverTool`, `get box`).

**Hook.** `browser_eval` matching `getBoundingClientRect|elementFromPoint|offsetParent|scrollHeight|
getComputedStyle` within 5 calls of a snapshot; snapshots <800 chars containing
`Canvas|SvgRoot|graphics-symbol|application "` and what follows within 2 calls; clicks returning
"not visible"/timeout on a ref present in the immediately preceding snapshot.

---

## 21. `Command failed: agent-browser <argv>` — one string for every failure class

**≈50/200 sessions · ~80 findings · ~200 wasted · sev 5 · novelty: new**
Fed by: error_message T1, T13; misleading "CLI and CDP plumbing text is passed through"; wait_timing F;
surprises T7; engine E6 (the eval half).

**Mechanism.** `execBrowser` (`server.ts:875-908`) builds its agent-visible message from
`error.stdout || error.stderr || error.message`. On an `execFile` timeout Node populates neither stdout
nor stderr, so `error.message` — literally `Command failed: agent-browser --cdp ws://… <every argv
element>` — becomes the error: no exit code, no stderr, no duration, and the word "timeout" nowhere. For
`eval` and `keyboard type` the model's own multi-KB payload is echoed back as the error body, which
reads as "your script is the problem". Raw CDP protocol strings stand in for input validation
(`CDP error (DOM.describeNode): Object id doesn't reference a Node` for an invalid selector; `Invalid
mouse button` for a missing argument), and one diagnosis is simply wrong (`Missing arguments for: set
headers` when they were supplied). Agents build superstitions that survive compaction.

**Evidence.**
- `agent-a7e6cfdf594aad47c` (steps 91-100): "after 29 seconds: `Error: Command failed: agent-browser
  --cdp ws://<redacted> eval (async () => { …entire script… })()` — the word 'timeout' appears nowhere".
- `agent-a64d4ab166234ea3c`: "'Command failed: agent-browser --cdp ws://<redacted> keyboard type <the
  whole text>' - no stderr, no cause; the real problem was an unescaped double quote" → generalised to
  "avoid all special characters" and shipped hyphens instead of em-dashes to a live site.
- `agent-a3b9ba43fcebe3c1f` (steps 18, 54-64): "Concluded 'the fetch with return in async context is
  failing' … 9 calls on a wrong hypothesis".
- `agent-aaa72aa0e5faf8bc2` (steps 37-115): "browser_run([\"wait\",\"25000\"]) succeeded at call 62 and
  failed at call 82 with 'Error: Command failed: agent-browser wait 25000' after burning 30s".
- `agent-a8f5b728fa18e68e7` (step 15): "`Invalid mouse button` - naming the CDP method instead of the CLI
  usage ('mouse down <button>')".

**Fix.** Branch in `execBrowser`'s catch on `error.killed`/`SIGTERM` → `agent-browser <verb> timed out
after 30s (no output produced)`, and never place `error.message` (which carries the argv and the CDP
socket) in agent-visible text — log it, return a verb-only summary and cap/strip any echoed script.
Add a mapping layer that classifies by exit code + stderr into (invalid selector / not valid CSS,
timeout with duration, element gone, browser gone, unsupported argument shape) and names the offending
argument plus the fix. Validate subcommand arity and enums in `/browser/run` the way `validatePressKey`
already does for `press`, returning the CLI usage line; reject newlines/unsupported characters in
`browser_type` up front; give `browser_eval` the pre-tokenized `args` transport `browser_run` has.

**Files.** `server.ts:875-908`, `/browser/run` `:1951-2010`, `/browser/type` `:1876-1900`;
`browser-output.ts` (`capBrowserOutput`, `redactCdpUrls`, `MAX_BROWSER_ERROR_CHARS`);
`browser-command-args.ts`; `press-key.ts` (the pattern to copy).

**Hook.** Results matching `^Error: (✗ )?(Command failed: agent-browser|CDP error \()`, bucketed by
call wall-clock (≥25 s ⇒ misreported timeout; 28–32 s ⇒ exec kill) and by whether the text contains the
tool's own input substring (script echo); count blind retries of the same verb afterwards; per session,
distinct error strings ÷ distinct error causes.

---

## 22. Truncation is lossy, mis-stated and uncontinuable

**≈50/200 sessions · ~65 findings · ~90 wasted · sev 5 · novelty: variant_of_known (`large_output`);
the unmarked cut and the fabrication-across-the-cut are new**
Fed by: misleading "Truncation notices misstate the cap"; snapshot_content TRUNC; action_result
`eval_cap`, `diag_firehose`; error_message T12; tool_surface #28; surprises T17; other T1, T5.

**Mechanism.** Three caps disagree with their own documentation and with each other:
`SNAPSHOT_SOFT_CAP_CHARS = 45_000`, `MAX_EVAL_OUTPUT_CHARS = 8000`, `MAX_BROWSER_OUTPUT_CHARS =
100_000` — the last of which sits *above* the SDK's tool-result limit, so a busy `network requests` log
is capped to 100 k and then hard-errors as too large. All of them keep the head and drop the tail, with
no offset, cursor or structural accounting, and the advice ("pass a tighter scope selector", "return
JSON.stringify of only the fields you need") is usually inapplicable: the agent needs all the rows, is
already scoped, is already stringifying, or the payload *is* one string. Some cuts land mid-JSON-token
or carry no marker at all.

**Evidence.**
- `agent-a7dd69d9e1ed275dd` (steps 13, 47): "'[snapshot truncated - 83367 chars total, showing 45000.
  Pass scope=…]' cutting off at rank ~56; scope cannot help when the wanted region IS the big one".
- `agent-a279c9892fc9e74cf`: "the final answer contains rows … that appear in NO complete tool result —
  they sit in the region cut off by '…[truncated — result was 14550 chars]'".
- `agent-a6f3b7b97ea9e2659` (step 12): "'Error: result (60,127 characters across 1,274 lines) exceeds
  maximum allowed tokens' plus ~150 words of MCP boilerplate … and never mentioning scope".
- `agent-a96647e032eb9726b` (step 27): "tool description says \"Output is capped at ~8000 chars\"; the
  actual truncation note read \"result was 89504 chars\"".
- `agent-a03b3997285611bb1` (row 52 of 100): "the truncation cut in at row 52 of 100, the worst possible
  place … phrased in a way that implied the rest was unloaded rather than merely unprinted".

**Fix.** Give `browser_snapshot` `offset`/`limit` or an `after="e123"` cursor and `browser_eval` a
`limit`/`offset`, and report the cut structurally: `showing rows 1-47 of 108` / `8000 of 36580 chars —
call again with offset=8000`. Truncate structurally rather than by prefix: drop option lists, footers
and repeated descriptions first, keep dialogs, alerts and forms. Never cut inside a JSON token — return
valid JSON plus `truncated:true` — and route every path through one choke point so no cut is unmarked.
Spill results over the cap to `/workspace/<name>.json` and hand back the path. Make the documented cap
match the enforced one, and lower `MAX_BROWSER_OUTPUT_CHARS` to the snapshot soft cap so no browser
result can hard-error at the SDK limit.

**Files.** `snapshot-format.ts` (`capSnapshot`, `SNAPSHOT_SOFT_CAP_CHARS`); `eval-script.ts:12,
115-123`; `browser-output.ts:16-25`; `tools/browser.ts:552-576` (the "~8000 chars" claim),
`server.ts:1943`.

**Hook.** Existing `large_output`, extended: compare the char count in each truncation notice against
the cap the tool description states; `JSON.parse` failures on payloads starting `[`/`{` with no
"truncated" marker; results within 1% of a known cap with no marker; truncation followed by another
read of the same target that never returns the tail; assistant messages containing items absent from
every tool result after a truncation.

---

## 23. `browser_get_state` is a non-atomic, un-knobbed bundle that reports failure as success

**≈48/200 sessions · ~60 findings · ~107 wasted · sev 5 · novelty: new**
Fed by: misleading "browser_get_state stitches three independently-taken observations"; tool_surface
#21; error_message T15; action_result `get_state_partial`; engine E5.

**Mechanism.** `tools/browser.ts:640-644` fires `get url`, `screenshot` and `snapshot` in `Promise.all`
with no shared timestamp and no pinned target — each sub-call independently re-resolves the active page
— and concatenates whatever comes back with `isError` never set. So three different instants are
presented as one observation, a dead browser prints the same CDP error three times inside a
success-shaped template, and a single failed leg hides inside an otherwise-normal result. It also
hardcodes `{interactive:true, compact:true}` with no `scope`/`fullText`/`screenshot:false`, so it always
spends an image and can never show static text.

**Evidence.**
- `agent-a19b566ea33c4f8a1` (step 54): "'Current URL: …CorpSearchResults.aspx' next to a screenshot and
  snapshot that are unambiguously the Rhode Island … entity search".
- `agent-a266cd6b8baa3a558` (steps 62-64, 447-450): "browser_get_state on a dead browser printed the same
  'CDP WebSocket connect failed: HTTP error: 410 Gone' three times as three separate field errors,
  obscuring the one actionable fact".
- `agent-aba469efcbca31a0f` (step 42): "'Current URL: Error - ✗ Auto-launch failed: CDP WebSocket connect
  failed: HTTP error: 410 Gone' alongside a complete, correct … snapshot".
- `agent-a3fb2aa030afdf800`: "reported 'Current URL: https://www.nickthegreek.com/nutrition-calculator/'
  while the browser was actually on mixt.com".
- `agent-a8c9fbaa4ccc77772` (steps 1-6): "a 62-option department combobox, 40 nav links … and a 75-link
  footer" for a five-field answer.

**Fix.** Resolve the target once, pin all three reads to it and run them sequentially; stamp the result
`tab t2 · <url> · captured <t>` and, when the URL changes between the first and last read, say "the
parts disagree — the page changed during capture" instead of returning a mixed view. Deduplicate
identical sub-errors into one line and set `isError` when every leg fails, with the recovery sentence
from theme 15. Expose the snapshot tool's parameters plus `screenshot:false`.

**Files.** `tools/browser.ts:635-692`; `active-page-target.ts`; `tab-manager.ts`.

**Hook.** `browser_get_state` results containing the same error substring ≥2 times, or `Error - ` under
≥2 field headings while the call is not marked as an error; results whose `**Current URL:**` disagrees
with the URL implied by the snapshot section or by the next `get url` within 3 calls; results >400 lines.

---

## 24. Fill/select read-back overclaims — and blames the site for harness bugs

**≈45/200 sessions · ~75 findings · ~220 wasted · sev 5 · novelty: variant_of_known (`custom_widget`);
the read-back target/timing and the false causal attribution are new**
Fed by: action_result `value_readback`, `false_failure`; misleading "Fill/select/type read-back
overclaims"; surprises T20; error_message T14.

**Mechanism.** `readCommittedFieldValue` (`server.ts:926-935`) runs `get value <ref>` and falls back to
`get text <ref>` — re-resolving the ref *after* the DOM may have moved, and reading a sibling's text on
a non-input ref. So the ⚠/verified line can name a neighbouring element's text as the field value,
certify `""` for a React-controlled input that still holds the old value, miss an append into a
contenteditable, certify a value autocomplete clears milliseconds later, or fire ⚠ on benign
normalisation. `judgeSelectCommit` compares the requested *label* against `element.value`, so a correct
selection reports "did not commit". And `formatFillReadback` asserts a cause — "The site reformatted,
truncated (maxlength), or rejected the input" — that the harness never established, so a rebound ref is
recorded as a fact about the site and carried for hundreds of calls.

**Evidence.**
- `agent-a07645aa2ae50bbb2` (steps 28-69): "*Typed 11 chars into e79 — field value is now: \"OAuth
  Scope\"*" (a column header) eight times; the agent wrote "always re-snapshot after typing rather than
  trusting the browser_type readback" into its compaction summary.
- `agent-aabb22c97745f184b` (call 282): "'⚠ Field value is now "Reels" - differs from the requested
  "speakeasy". The site reformatted...' - the site did nothing of the sort; ref e10 had been rebound".
- `agent-ae454d50a96b7fe47`: "'select reported success but the value did not commit (requested
  "California", element value is still "CA")' - CA *is* California".
- `agent-a074a56112ffae35d` (steps 55-65): "*Filled e26. Field value verified: \"\"*" while React state
  kept "Reading" and the list stayed filtered.
- `agent-a483801464b3efe0d` (steps 137-149): "*`Selected \"US\" in @e71.`* — nothing was selected; @e71
  was an ARIA combobox with no <select> behind it"; the agent filled four more fields on a broken form.

**Fix.** Read back from the element the write actually targeted (capture the handle at write time, do
not re-resolve), use `textContent` for contenteditable, re-read after a settle/blur or a `change` event,
and verify the ref still identifies the element the snapshot named before saying anything about the
site. Compare a select against the option's value **or** its visible label **or** its index, and print
both. Refuse `browser_fill` on non-fillable refs; read back the focused element for ref-less
`browser_type` instead of the payment-iframe sentence. Rename "verified" to "current DOM value", do not
truncate below the requested length, normalise before comparing, and replace the causal sentence with an
observation plus candidate causes including "the ref may have rebound — re-snapshot and retry". Never
return `isError` for an action whose side effect is observable.

**Files.** `server.ts:926-935`, `/browser/fill` `:1529-1564`, `/browser/type` `:1868-1948`,
`/browser/select` `:1728-1776`; `browser-digest.ts` (`formatFillReadback`); `field-value-readback.ts`;
`select-verify.ts`; `tools/browser.ts:261-287, 415-435, 522-550`.

**Hook.** Existing `custom_widget`, extended: fill/select successes where a later snapshot or dialog
within 15 calls shows the field empty or an error naming it; "did not commit" errors where the reported
value equals the requested label's option value; ⚠ read-backs whose "now" value matches another
element's name in the last snapshot (rebound ref); `isError` results followed within 3 calls by evidence
of the intended effect, or by a retry that duplicates state.

---

## 25. Capabilities exist but are undiscoverable at the moment of need

**≈52/200 sessions · ~30 findings · ~210 wasted · sev 4 · novelty: variant_of_known (`escape_hatch`) —
the late-discovery latency is new**
Fed by: surprises T13; tool_surface #12; prompt_guidance #8, #16; misleading "prompt describes behavior
the harness no longer has".

**Mechanism.** `scope`, `fullText`, `includeUrls`, `json` and `annotate` live only in the Zod schemas;
`focus`, `scrollintoview`, `find role|text … click`, `get box`, `get text`, `network requests --filter`,
`network route`, `wait --text`, `set viewport`, `drag` and `frame` live only inside `browser_run`'s
25-line command dump, which no prompt surface references and which never mentions that `--help` exists.
`web-browser-agent-prompt.md`'s hand-written tool block advertises `browser_snapshot(interactive?,
compact?)` and `browser_screenshot(full?)` and its only sizing advice describes the defaults. Agents
name the flag they need and never use it, or find the right command 50–140 calls late — at which point
it resolves the impasse in one call.

**Evidence.**
- `agent-aa55dcd56adb9913f` (136 calls): "typed the name of the right flag twice … and then never used
  fullText, scope or includeUrls once — a parameter that lives only in the schema does not exist at the
  moment of decision".
- `agent-a83ec31ce1e1dd4dc` (call 28): "`annotate` is undocumented in the system prompt's tool list, and
  when the agent stumbled on it at call 28 it solved a 22-call impasse in a single call".
- `agent-ad1e4171e5f4353d0` (step 139): "ran browser_run('network requests --help') at call 139,
  discovered --filter/--clear, and from then on used clear → click → click → --filter (4 calls, one line
  of output)".
- `agent-a266cd6b8baa3a558` (491 calls): "`scope` and `includeUrls` — designed for exactly these — were
  used 0 times in 491 calls"; `annotate:true` and `find role … click` likewise zero.
- `agent-a76edacff87396fb2` (step 53): "nothing in the prompt or browser-use.md mentions `focus`; the
  agent guessed it after 35 calls of failure".

**Fix.** Regenerate the prompt's tool block from the actual Zod schemas and assert equality in
`agent-browser-upgrade.test.ts` / `system-prompt-vars.test.ts` (they already watch these files). Promote
the load-bearing commands to typed tools — `browser_focus`, `browser_scroll({to})`,
`browser_network({filter})`, `browser_viewport()`, `browser_text()` — and name semantic clicking
(`find role button click --name X`) as the documented fallback when a ref will not click. Move discovery
into the *output*: when a snapshot is degenerate or truncated, append the one option that fixes it; when
a screenshot returns, append the ref legend and the `annotate:true` hint; when a click result is
ambiguous, name `get text`/`get box`. State in `browser_run`'s description that
`browser_run(["<cmd>","--help"])` lists the full option set.

**Files.** `web-browser-agent-prompt.md`; `tools/browser.ts:169-233` (snapshot prose), `:371-405`
(screenshot/annotate), `:578-633` (`browser_run` catalogue); `snapshot-format.ts` (hint text).

**Hook.** Per session, first-use call index of `focus`/`scrollintoview`/`find`/`--filter`/`includeUrls`/
`scope`/`annotate`/`set viewport`/`--help` as a fraction of session length; sessions where first use is
>50 calls in or is preceded by a `--help`; snapshots passing only defaults while a result in that
session was truncated or had <10 nodes.

---

## Remaining merged themes

| Theme | Sessions /200 | Findings | Wasted | Sev | One-line fix |
|---|---|---|---|---|---|
| 26. Single-result trust collapse retires a whole tool | ~43 | 43 | ~100 | 4 | Label every error transient-vs-permanent, retry degenerate snapshots internally, and nudge back to the typed tool after N interaction-shaped evals. |
| 27. Upload verdicts derived from the input's internals; ambiguous selectors hidden | ~32 | 43 | ~75 | 5 | Report how many inputs matched and which was used, verify by observing the page (navigation/DOM/network), attach the navigation digest, and arm Playwright's `filechooser` so clicking the visible control works. |
| 28. Diagnostic firehose: `network requests`/`console`/`storage` unshaped and unredacted | ~30 | 42 | ~70 | 5 | Typed `browser_network({urlContains,type,status,since,limit,includeBody})`; dedupe repeated URLs, elide `data:`/query tokens, filter provider keepalive lines, attach the console listener at navigation. |
| 29. Tab hygiene is prompt ritual the runtime does not need | ~33 | 32 | ~39 | 4 | Delete "check tabs every 5 actions"; the count-gated warnings already carry the policy — put the tab line on `browser_open`/`screenshot`/`wait` results instead. |
| 30. `request_browser_input`: unbounded wait, misattributed cancellation, no picture | ~20 | 11 | ~48 | 5 | Bound the wait to minutes with the deadline in the description, attach the current screenshot, re-target the request across provider/browser churn, and return a prescriptive next action instead of "the user may want to discuss". |
| 31. `BROWSER_USE_GUIDANCE_HINT` tells the web-browser agent to delegate to itself | 33 | 33 | 33 | 3 | Pass the caller identity into `createBrowserTools` and suppress the hint for this subagent; emit at most once per session otherwise. |
| 32. No budget signal: sessions end holding the answer | ~19 | 6 | 0 | 5 | Append a budget line past 80%/98% of `maxTurns: 500` and synthesize a handoff (last URL, mutations performed) on exhaustion. |
| 33. Nothing supports read-only / irreversible-action discipline | ~18 | 18 | 0 | 5 | `browser_probe(ref|x,y)` preflight (tag, name, owning form, `type=submit`), keep "live/production/delete" banners in the compact tree, and confirm effects so nothing is fired twice "to verify". |
| 34. `browser_open` tab dedupe declines to navigate and does not say so | ~15 | 20 | ~67 | 5 | Match on the tab's committed URL incl. fragment, refuse `chrome-error://`/`about:blank` as a hit, add `reload:true`, and say what was *not* done. |
| 35. No value-setting path for date/range/custom-combobox/chip widgets | ~15 | 9 | ~321 | 5 | `browser_set_value(ref, value)` branching on the resolved element (native setter + input/change, Playwright fill, or the whole open→filter→pick→verify sequence in one call); delete the 5-call ritual from the prompt. |
| 36. Harness defects become durable model beliefs (and parent prompts) | ~19 | 19 | 0 | 3 | Attribute limits in harness language ("the a11y tree does not carry layout — screenshot it") so the model records a capability boundary, not a site theory; treat `browser_eval` instructions in parent prompts as a regression signal. |
| 37. Shadow DOM and nested frames are not traversed | ~10 | 12 | ~114 | 5 | Pierce open shadow roots in snapshot/`find`/`wait`/`scope`, never terminate the walk at a frame, and footnote closed roots the way cross-origin frames are footnoted. |
| 38. Parallel calls in one turn clobber each other; both report success | ~10 | 10 | ~42 | 5 | Serialize `/browser/*` mutations per session and tell the losing caller it was superseded; name the sibling action when a batched ref action fails. |
| 39. Downloads are invisible end to end | ~9 | 11 | ~146 | 5 | Subscribe to CDP `downloadWillBegin`/`downloadProgress`, append "Download started/complete: name → path (bytes, type)" to the triggering action, add `browser_downloads()`, and document the 100 MB cap. |
| 40. Subagent toolset gaps: no write, no fetch, no secret, no listing | ~9 | 9 | ~81 | 5 | Add `Write`/`browser_save_text` and `browser_fetch(url)`, resolve `{env:"…"}` secret references server-side with masked read-back, and fix `Read`'s binary refusal firing before the existence check. |
| 41. Emulation is per-navigation and never reported | ~8 | 8 | ~43 | 5 | `browser_viewport({width,height,deviceScaleFactor?,mobile?,device?})` stored in `browser-state.ts` and re-applied on every commit, echoed in the open result and every snapshot/screenshot footer. |
| 42. Code/rich-text editors have no write path and the click is refused | 7 | 7 | ~170 | 5 | Editor-aware fill: detect `.cm-editor`/`.monaco-editor`/`.ace_editor`/`[contenteditable]`, focus the visible surface and dispatch a real paste/`insertText`; expose the same for reading. |
| 43. Secrets are echoed into transcript and context | ~6 | 6 | 0 | 3 | Mask values whose label or shape says credential (`xox[bap]-`, `sk-`, JWT) in snapshots and read-backs, showing prefix + length; add credential creation to the confirm-before-submitting rule. |
| 44. Prompt and tool descriptions drift from shipped behaviour | 6 | 6 | 6 | 3 | One reconciliation pass plus a test that fails when a prompt claim names a string the tools never produce. |
| 45. No batch or iteration primitive | 5 | 5 | ~114 | 4 | `browser_click({refs:[…]})` / `{role,name,all:true}` that re-resolves between clicks and returns one state line each; `expandAll` on snapshot. |
| 46. Compaction drops extracted data; the recovery pointer is unusable | 2 | 2 | ~16 | 4 | Grant `get_session_transcript` scoped to the subagent's own session (or drop the footer line), and preserve tool-result-derived values in the compaction preamble. |
| 47. `browser_type` is append-only, per-character, unverified without a ref | 3 | 3 | ~8 | 4 | Add `clear:true` and `mode:'insert'` (one `insertText` event); lead the description with the ref form and demote the payment-iframe framing. |
| 48. Drag-and-drop absent from the tool surface | 2 | 2 | ~32 | 5 | First-class `browser_drag({from,to})` with waypoints; mark `draggable`/drop-target elements in the snapshot. |
| 49. Keyboard/mouse primitives silently deliver nothing | 2 | 2 | ~12 | 4 | Fix the CDP key mapping for digits/`DigitN`, reject key names the mapping cannot deliver instead of returning success, and establish the trusted-event/focus precondition for drags. |
| 50. Geo/locale invisible, so seeded form defaults ambush flows | 1 | 1 | 2 | 3 | Report effective locale/TZ/apparent geo in the open result, or pin them deterministically at browser start. |
| 51. Cookie/console dumps unbounded and unfiltered | ~2 | 2 | 0 | 1 | Truncate cookie values / add a names-only mode; filter provider keepalive lines out of `console`. |

---

## Prompt guidance that cost time

All quotes verified verbatim in `agent-container/src/web-browser-agent-prompt.md` (and the tool
descriptions in `tools/browser.ts`) in this worktree.

- **"Trust the action results … Don't re-snapshot just to confirm an action worked."** (Core Workflow
  §4) — the digest can only compare URLs. On SPAs this is advice against the observation the click was
  made for; obeying it shipped an OAuth app with zero scopes, a wrong date, and a "complete" ad set of 5
  of ~230. Scope the rule to navigation, and only after the digest carries an effect.
- **"Tab Management (MANDATORY)" — 7 numbered rules, the prompt's largest and only MANDATORY block,
  including "Check tabs every 5 actions" and "The snapshot footer also shows your tab count."**
  `formatTabStatus` returns `''` at ≤1 tab, so in single-tab sessions (the overwhelming majority) the
  footer never appears and the mandated probe is pure overhead — 24+ sessions of no-op `tab` listings,
  one 30 s timeout, and one session that halted a task citing "risk exceeding the browser tab limit".
  Delete the periodic mandate; keep reuse and "a click may open a tab".
- **"NEVER close the browser. You do not have the browser_close tool."** — false: `claude-code.ts:1086`
  grants `mcpToolNames('browser', browserMcpTools)`, and `tools/browser.ts:694` exports
  `browserCloseTool`. Meanwhile the CLI's own error tells the agent to run `agent-browser close`. The
  agent is denied a capability it holds at the exact moment it needs one.
- **"ALWAYS report the current URL when you finish (use `browser_run("get url")`)."** — a rule phrased
  as a tool invocation, because no snapshot carries a URL: one guaranteed extra call per session
  restating what the last digest printed, and a fabricated URL when answered from memory
  (`agent-a1f88ee4075f41bfa`). Put the URL in the snapshot header and reword to "state it in your final
  message".
- **"browser_wait(for) — Wait for a CSS selector … Do NOT use for load states — `browser_open` already
  waits for the page to load."** — the load claim is false (theme 2), and the prohibition hides the
  `ms`/`--text`/`--url`/`--fn` modes the CLI has, pushing agents to `wait("body")` no-ops and eval
  `setTimeout`.
- **"browser_screenshot(full?) — Take a screenshot (returns file path; use Read to see the image)"** —
  the image is already returned inline; agents `Read` the same picture twice.
- **"browser_snapshot(interactive?, compact?)"** plus **"Use interactive + compact snapshot to reduce
  output"** — omits `scope`, `fullText`, `includeUrls`, `json`, `annotate`, and describes the defaults as
  if they were an optimisation. One session ran 101/101 default snapshots into a context exhaustion.
- **browser_select's custom-dropdown recipe** ("click the trigger, re-snapshot, type into the filter
  input, click the option's FRESH ref … re-snapshot between selections") — the harness documenting a
  five-call ritual per selection; 38 calls for 7 items in one session, 70 for 14 scopes in another.
- **"For file uploads, target the actual `<input type="file">` … Do not click 'Upload' buttons."** —
  exactly backwards where the input only exists after the control is clicked (or is created detached),
  and hidden inputs are not in the a11y tree at all, so the selector the rule demands must be found by eval.
- **"Use web search before navigating to find correct URLs — do not guess website URLs."** — covers site
  roots but not in-site deep links; agents guessed `?q=` URLs and got homepages and 404s. Add "never
  guess in-site query URLs — use the page's own search control".
- **"When you encounter a login page, CAPTCHA, 2FA … IMMEDIATELY call `request_browser_input`"** — no
  tier for a checkbox the agent can tick itself (148 s of human latency for one that was still
  `[checked=false]` afterwards), no branch for a read-only lookup web search answers, and the trigger is
  a literal word list that a silent HTTP-200 PerimeterX interstitial matches none of.
- **`BROWSER_USE_GUIDANCE_HINT`** appended to both `browser_open` return paths (`tools/browser.ts:137,
  147`) with no caller check — advises the web-browser subagent to consider delegating to the
  web-browser subagent, up to 50 times per session; the code comment above it describes a conditionality
  that was never implemented.
- **The payment-iframe sentences** (`tools/browser.ts:527, 543`; `formatIframePlaceholders`) — fire on
  every ref-less `browser_type` and every snapshot with any opaque frame, including notes apps, Gmail
  reads, Instagram logins and Slack settings, and the coordinate click they recommend does not exist.

## Things the harness got right

- **The covered-by error's *shape*.** Reviewers in ~8 sessions named it the best output in the harness:
  what happened, what is in the way, what to do. Keep the shape; fix the false positives and add a
  remedy the agent can perform.
- **The fill/select read-back concept.** `browser_fill` and `browser_select` verify their effect and are
  the two verbs agents trust without re-checking. The idea is right — the read-back's target and timing
  are what is wrong.
- **The scroll digest on plain documents.** Repeatedly called excellent; measured numbers, position
  language, "(top/bottom of page)". Only the inner-scroller case lies.
- **Count-gated tab warnings.** `formatTabStatus`/`formatTabWarning` correctly stay silent at ≤1 tab and
  escalate near the limit — the runtime policy is right; only the prompt's unconditional ritual is wrong.
- **`redactCdpUrls` + `capBrowserOutput`** keep CDP sockets and 1 MiB partial outputs out of the model's
  context in the normal path; the leaks are the exception, not the rule.
- **`press-key.ts` shape validation** rejects multi-character strings with good typing guidance — the
  model to copy for every other verb's argument validation.
- **The capabilities themselves.** `find role … click`, `focus @ref`, `scrollintoview`, `get box`,
  `drag @a @b`, `annotate:true`, `network requests --filter`, `wait --text`, `browser_download` (with
  cookies and login) all worked first try when found — one drag "worked first try and was reused
  instantly at calls 106/160/163". Discovery is the defect, not the capability.
- **The tree beats pixels on semantic markup.** Six counter-example sessions:
  `agent-a6aedfd9973cc1f49` (Instagram rows carry handle + Verified + follower count in one name),
  `agent-abb0ccad266130160` (snapshot showed seven search terms the screenshot truncated),
  `agent-afaa80d8634cfe696` (`button "Next" [disabled]` correct where the image misled),
  `agent-acd700143f37f3ddf` (revealed token came through as a literal value),
  `agent-a967e72dc5ded5664` and `agent-ae59911135342475a` (icon buttons better named than legible).
- **Tab reuse on `browser_open`** genuinely prevents proliferation; the defect is silence about *not*
  reloading, not the dedupe.
- **Parallel batching** (an eval and a screenshot in one turn) works cleanly and is part of why one
  session was 38 calls rather than 50.

## Not harness

- **Site-side:** genuine credential walls, CAPTCHAs and 2FA; Imperva/PerimeterX/Cloudflare bans and
  IP-level blocks; sites that consume and clear a file input or create it detached; autocomplete that
  clears a filled field; Craigslist silently widening the search radius; Instagram reel view counts
  living only on the `/reels/` sub-tab; hashed/generated class names that defeat any selector advice;
  provider billing state (`402 billing_past_due`) — vendor-side, though its *presentation* is ours.
- **Model-side:** hallucinating four-digit refs (invited by ref opacity and legend-less screenshots, but
  still a model error); reporting from the visible half of a truncated result and asserting
  completeness; writing a confident report out of web-search snippets rather than disclosing the
  browser was down; choosing "Never" as the expiry for a write-scoped access token and printing it in
  plaintext; submitting a user's real email harvested from another site; skipping the spill file and
  downgrading a task requirement instead; never trying `location="container"`; re-deriving a token
  visually that was already verbatim in its own context.
- **The bound on all of it,** from `agent-a03b3997285611bb1`: "the harness works well on semantic markup
  and does nothing to compensate when markup is poor." Most themes above are instances of that sentence.

## New detectors to add

Existing detectors keep firing; these are the measurement hooks for themes marked new or variant.

1. `text_omission` — snapshot/get_state with `fullText` unset followed within 3 calls by a screenshot or
   an `innerText|textContent` eval on the same URL; plus per-session `fullText` usage rate.
2. `no_page_identity` — `browser_open` followed within 2 calls by `get url`/`document.title`/
   `location.href`/snapshot; and snapshots containing `(no interactive elements)`/`(empty page)` whose
   URL later yields a non-empty tree.
3. `digest_no_effect` — `URL unchanged (` results where the next snapshot within 3 calls differs by >5%
   of lines; and `URL unchanged` results with no following observation whose next action uses a pre-click ref.
4. `toast_only_fact` — a click followed by a screenshot with no snapshot, where the next assistant
   message quotes a string absent from every prior snapshot.
5. `snapshot_repeat_ratio` — total snapshot chars ÷ distinct chars per session; flag >60% line repeat
   against the previous snapshot of the same URL, or any name string appearing ≥5 times in one result.
6. `option_run` — ≥10 consecutive `- option "` lines under a node whose line contains `expanded=false`.
7. `scope_amplifier` — scoped snapshot longer than the previous unscoped snapshot of the same URL, or
   repeating a `[ref=eN]` token; plus scope-abandonment (no further `scope` after the first error).
8. `aria_grammar_in_css_slot` — a `scope`/`for` argument equal to an ARIA role token or an accessible
   name printed in the previous snapshot.
9. `ref_rebind_silent` — the same accessible name mapping to different ref tokens across two snapshots
   of one URL with no navigation digest; and ref actions ≥1 mutating action after their snapshot that
   return no error.
10. `ref_invented` — ref tokens in tool inputs that never appeared in any prior snapshot result.
11. `wait_noop` — `Wait condition "X" satisfied.` with wall-clock <250 ms, or `for` ∈ {body, html, *, a,
    img, h1, div, main}; flag a session as *silently mispaced* when such a wait sits between navigations.
12. `wait_bad_syntax` — `for` matching `^(text|role|id)=|:has-text\(|>>` or `^\d+\s*(ms)?$`.
13. `escalating_sleep` — ≥2 non-decreasing sleeps (`browser_run wait <digits>` or eval `setTimeout`)
    separated by observations at one URL.
14. `iframe_footer_false` — `contents NOT in this snapshot` where the named host equals the page host or
    the same body has a ref line under that frame; plus the payment sentence in sessions with no frame fill.
15. `overlay_unannounced` — a `covered by` error whose covering selector never appeared in the preceding
    snapshot; and a click on an `expanded=false|haspopup` ref followed by a snapshot with no new
    `menu|listbox|dialog`.
16. `state_by_screenshot` — ≥3 click→screenshot pairs with no intervening snapshot; and snapshots where
    ≥2 same-role siblings share a name with no `[checked|selected|pressed|current]` token anywhere.
17. `flat_records` — >50 consecutive `cell`/`button` lines at one indent with no `row`/`table` ancestor,
    followed by an array-returning eval.
18. `unnamed_ref_density` — share of `(generic|button|link) [ref=` lines with no quoted name; flag >20%
    and correlate with invented refs and misclicks.
19. `false_navigated` — `Page NAVIGATED — now at X` where X equals the previous URL or differs only in
    fragment/query order/encoding/trailing slash; plus digests whose URL is contradicted by the next result.
20. `scroll_noop` — identical `Viewport now shows A–B of T` across consecutive scrolls, `y===0 &&
    pageHeight===viewportHeight`, or a horizontal scroll reported with a vertical range.
21. `foreign_navigation` — a reported URL/host change with no `browser_open`/back/forward/navigating
    click in between; tab listings containing ids or labels the session never created; footer tab count
    disagreeing with the nearest listing.
22. `exec_kill` — `Command failed: agent-browser` with call wall-clock in [28 s, 32 s], or ≥25 s
    (misreported timeout), or whose text contains the tool's own input (script echo).
23. `browser_dead_run` — runs of ≥2 results matching the death/launch signatures, scored by run length
    before the next successful `browser_open`; plus sessions with 0 successful browser calls and >20 calls.
24. `contentless_success` — results whose entire body is `✓ Done` / `Command executed.` / `(no output)`
    for a read verb, correlated with a final message asserting an absence.
25. `pixel_space_guess` — an eval reading `innerWidth|devicePixelRatio` within 3 calls of a screenshot;
    `Unknown subcommand: click`; consecutive `mouse move`→`down`→`up` triples; per-session image bytes vs cap.
26. `unmarked_truncation` — payloads starting `[`/`{` that fail `JSON.parse` with no "truncated" marker,
    or within 1% of a known cap with no marker; plus final-answer items absent from every tool result.
27. `get_state_incoherent` — the same error substring ≥2 times in one `browser_get_state`, or its
    `**Current URL:**` disagreeing with its own snapshot section or the next `get url`.
28. `readback_blames_site` — ⚠ read-backs whose "now" value matches another element's name in the last
    snapshot; "did not commit" errors where the element value is the requested label's option value.
29. `late_capability` — first use of `focus`/`find`/`scope`/`fullText`/`annotate`/`--filter`/`--help`
    past call 25 where it immediately resolves a repeated failure.
30. `tool_retirement` — for each tool, whether it is ever called again after its first error or false
    success; per session, the eval:typed-tool ratio in the first vs last third.
31. `session_no_handoff` — sessions whose last event is a tool result, or whose final message contains no
    URL; bucketed by whether the 500-turn cap was hit.
32. `unsupervised_mutation` — sessions whose task text contains {do not, read-only, don't submit} that
    contain a click on a ref with an empty accessible name, or raw `mouse down/up`.
