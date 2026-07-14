# Handover: Windows Firewall work — PR #459 + PR #465

**For:** the agent working interactively on Iddo's Windows machine (Iddo is present — you can run commands and ask him things).
**Goal:** resolve two open mysteries, finish validation of both PRs, fix one confirmed defect in #459, and get both PRs merge-ready.
**Delete this file from the branch before merge.**

---

## 0. TL;DR — do these in order

1. **Establish ground truth on this machine** (§5.0): how many Gamut processes, which port the API actually bound, which container runner is active. Both mysteries likely fall out of this.
2. **Mystery #1** (§5): banner not showing despite 3 Block rules. Ranked hypotheses with exact tests.
3. **Mystery #2** (§6): `wget … Connection refused` from the WSL distro + "browser works despite Block rules". Likely port/instance or runner-path explanation, NOT a firewall behavior.
4. **Fix #459's inert probe** (§3.2): bundled Alpine distro has no `curl` (confirmed on this machine) → probe always returns `unknown`. Implement busybox-`wget` fallback + tests.
5. **Run the full validation matrix** (§7) for both PRs.
6. Report findings to Iddo between steps. **One fix at a time; wait for his go** (standing rule).

---

## 1. Background — why these PRs exist

### The architecture facts you need

- The Electron app runs an API server bound `0.0.0.0` (`src/main/index.ts` ~1349), default port **47891** (`DEFAULT_API_PORT`). On a port race it **binds upward and updates `process.env.PORT`** — so `getAppPort()` (`src/shared/lib/proxy/host-url.ts`) is correct for containers started after bind, but **any hardcoded 47891 in your testing may be wrong. Always discover the real port first (§5.0).**
- Agent containers run in the bundled WSL2 distro **`superagent`** via nerdctl (`src/shared/lib/container/wsl2-container-client.ts`). Containers reach the host at `host.docker.internal:<port>` = the WSL NAT gateway IP (from `wsl -d superagent -- ip route show default`), injected via `--add-host`.
- **Traffic directions matter.** Chat/streaming = host→container + loopback + container→cloud: never firewall-filtered. Only **container→host** inbound (browser launch, `/api/proxy/*` Composio calls, MCP proxy) crosses Windows Firewall — and **only on runners where that traffic arrives on a real interface** (bundled WSL2 NAT). Docker Desktop forwards `host.docker.internal` through local proxying that arrives via **loopback, which Windows Firewall never filters** (`getHostBridgeIp()` returns null for it). This distinction is likely the answer to Mystery #2b.
- Host-browser mode (Browser Host = Google Chrome): container calls `POST <HOST_APP_URL>/api/browser/launch-host-browser` (`agent-container/src/server.ts` ~726) → host launches Chrome, CDP bound to `127.0.0.1`, plus a TCP proxy bound to the WSL gateway IP on a random **ephemeral** port (`src/main/host-browser/chrome-provider.ts`) → container fetches `http://host.docker.internal:<proxyPort>/json/version`.

### The original incident (jafar@nextool.ai, 2026-07-13, live-debugged)

User on Gamut 0.4.11/WSL2: browser tool failed with bare `fetch failed`, no Chrome window, **zero Sentry events**. Root cause: the first-run Windows Firewall "Allow access?" prompt had been cancelled, which writes persistent `Inbound / Block` rules for `gamut.exe`. Every container→host call died before reaching the host; the host never saw anything to report. Chat kept working (loopback/outbound). Fixed live: delete Block rules + add program-scoped Allow rule (elevated PowerShell).

**Diagnosis signature** (memorize): *no Chrome window + agent reports bare `fetch failed` + zero Sentry browser events* = launch request never reached the host.

**Counter-signature learned today**: *`Connection refused`* (instant) from a WSL-side probe is **NOT** a firewall block — Windows Firewall **drops** (≈5s hang, then timeout / wget "download timed out"). Refused = nothing listening at that ip:port. Treat refused as "wrong port / wrong instance / app not running", never as firewall.

---

## 2. PR #465 — `feat/firewall-detect-remediate` (detection + banner + fix)

https://github.com/SkillfulAgents/SuperAgent/pull/465 — 3 commits:

1. `30c95860` feature:
   - `src/main/windows-firewall/index.ts` — detection: non-admin PowerShell enumerates **enabled Inbound Block rules whose application filter targets `process.execPath`** (reading rules needs no elevation), plus a `Get-NetFirewallHyperVVMSetting` read (WSL VM-creator GUID `{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}`). Result cached 5 min; `refresh` bypass. Reports to Sentry (`component:firewall`, `operation:detect`) once per process when blocked. **Fail-safe: any probe failure → `blocked:false` + `captureException`** — a broken probe must never show a false banner (this also means a silently-broken probe hides real blocks — relevant to Mystery #1).
   - `fixFirewallBlock()` — writes a temp `.ps1`, runs it elevated via `Start-Process -Verb RunAs` (outer wrapper exits **223** when UAC is declined → distinct `uac-declined` result). Script: remove Block rules scoped to our exe, add Allow rule **`"Gamut agent connections"`** (`-Direction Inbound -Program <exe> -Action Allow -Profile Any`), then **re-detect and only report ok if actually clear**.
   - `src/main/windows-firewall/firewall-schema.ts` — Zod at the process boundary; handles PowerShell 5.1 single-element-array JSON collapse.
   - `src/api/routes/firewall.ts` (`GET /api/firewall/status`, `POST /api/firewall/fix`, `Authenticated()`), registered in `src/api/index.ts`.
   - Renderer: `src/renderer/hooks/use-firewall-status.ts` (query, 5-min refetch + fix mutation that writes fresh status into the cache) and `FirewallBlockedSidebarBanner` in `src/renderer/components/runtime/runtime-status-banners.tsx`, mounted in the sidebar stack in `src/renderer/components/layout/app-sidebar.tsx`. States: idle → `Fix now →` / fixing → `Waiting for Windows approval…` / declined / failed.
   - `build/installer.nsh` + `package.json` `nsis.include` — netsh pre-seed of the same Allow rule, **gated on the installer running elevated** (`UserInfo::GetAccountType`): our NSIS installer is per-user and normally unelevated, and electron-updater silent updates must never trigger UAC. Banner = primary path; installer rule = opportunistic. **Rule name must stay in sync with `ruleDisplayName()`** (`<exe basename> agent connections`).
   - Dev/test: `SUPERAGENT_FAKE_FIREWALL_BLOCK=1` fakes a block (gated `!app.isPackaged` in Electron / non-production web, mirroring `SUPERAGENT_TEST_UPDATES`). Gated E2E `e2e/specs/firewall-banner.spec.ts` drives route→hook→banner→fix.
2. `fd56c147` **false-positive fix (important lesson)**: the Hyper-V `DefaultInboundAction: Block` for the WSL VM creator is (a) a **stock Win11 24H2 default** and (b) governs traffic **into the WSL VM**, not WSL→host — it fired the banner on Iddo's healthy machine, and the old fix script would have "resolved" it by weakening that default. Now: `blocked` keys **strictly** on explicit Block rules against our exe; Hyper-V value is telemetry-only; the fix script contains **no** Hyper-V commands. Never re-add posture heuristics as banner triggers.
3. Unit tests: 14 in `src/main/windows-firewall/windows-firewall.test.ts`.

### Proven working (do not re-litigate)

On **this machine**, earlier today (Sentry, `iddo.gino@datawizz.ai`): `Windows Firewall is blocking container-to-host connections` at 23:24:25Z (GET /api/firewall/status) and `Windows Firewall block remediated via in-app fix` at 23:24:51Z. So detection → Sentry → banner → UAC fix → re-verify all worked end-to-end once. (That detection was the hyperV false positive, but the pipeline is the same.) ⚠ Sentry `release` shows `0.4.11` for PR builds too — release tag cannot distinguish PR build from prod.

### Machine-state ledger (Iddo's Windows machine — verify, don't assume)

- Fix was clicked once (23:24Z) → Allow rule `"Gamut agent connections"` was created. Iddo then reverted the Hyper-V setting to Block (undo instructions were given); the Allow rule was recommended to keep — **may or may not still exist**.
- Iddo then created a simulated block: `New-NetFirewallRule -DisplayName "gamut.exe" … -Action Block -Profile Private,Public`. Current state shows **three** `gamut.exe / Inbound / Block / True` rules (he created one — the other two are probably a real cancelled-prompt pair from history; ask him / check `Get-NetFirewallRule -DisplayName gamut.exe | Get-NetFirewallApplicationFilter` to confirm all three target the same path).
- PR build installed from run 29293135766 artifact `Superagent-Windows-Setup` over the existing install.
- Despite the Block rules: **no banner** (Mystery #1) and **host-browser mode works** (Mystery #2b), and a WSL-side probe to `172.24.27.184:47891` got **Connection refused** (Mystery #2a).

---

## 3. PR #459 — `feat/cdp-proxy-firewall-probe` (probe + agent-facing messages)

https://github.com/SkillfulAgents/SuperAgent/pull/459 — 2 commits:

1. `70b433a0`:
   - `ContainerClient.probeHostPortFromRunner(host, port)` → `'reachable' | 'unreachable' | 'unknown'` (base `'unknown'`; only `'unreachable'` may ever fail a launch). WSL2 impl: **`curl` inside the distro** against the CDP proxy after launch; `classifyProbeCurlExit`: exit 7/28 → unreachable, 0 → reachable, else unknown.
   - `chrome-provider.ts`: after Chrome is up and the proxy bound, probe; on `unreachable` → captureException (`operation:cdp-proxy-reachability`) + tear down Chrome/proxy + throw an actionable firewall message that flows route→container→agent.
   - `agent-container/src/server.ts`: network-failure wrap around the container's `GET /json/version` (firewall diagnosis instead of `fetch failed`).
2. `c2cb1d5f`: same wrap around the earlier hop — the launch POST to `HOST_APP_URL` itself (this is the exact jafar failure surface).

### 3.2 CONFIRMED DEFECT — fix before merge

**The bundled Alpine distro has no `curl`** (verified on this machine: `curl: not found`). So the WSL2 probe always exits 127 → `'unknown'` → never fails a launch (fail-safe held ✅) but **never detects anything** (probe inert ❌).

**Fix spec** (in `wsl2-container-client.ts`):
- Try `curl` first (cheap, correct exit codes). On exit 127 (or ENOENT-ish), fall back to **busybox `wget`**: `wsl -d superagent -- wget -q -O /dev/null -T 4 http://<host>:<port>/json/version`.
- Busybox wget exits 1 for nearly all failures — **you must classify stderr**: `Connection refused` → `unreachable`; `timed out` / `download timed out` → `unreachable`; exit 0 → `reachable`; anything else (including HTTP errors, wget absent) → `unknown`.
- **First verify busybox wget's actual flags/messages in the real distro** on this machine: `wsl -d superagent -- wget 2>&1 | head`, and probe a known-open + known-closed port to capture the exact stderr strings before writing the classifier. Don't trust the spec above over observed output.
- Add unit tests beside the existing curl-classifier tests in `src/shared/lib/container/wsl2-container-client.test.ts` (note its `child_process` mock exports `execSync`, `spawn`, `execFile` — extend as needed).
- Alternative considered and rejected for now: `apk add curl` at distro provision (needs network at setup; larger blast radius).

---

## 4. What we know about why "browser works despite Block rules" CAN be legitimate

Before treating Mystery #2b as a detection bug, know the legitimate paths:

1. **Loopback exemption**: Windows Firewall does not filter loopback. If this machine's active runner is **Docker Desktop** (check Settings → runtime, or `Get-Process "com.docker*"`), container→host arrives via loopback and Block rules on gamut.exe are harmless — browser works, and the banner is arguably a false alarm *for current traffic* (but still correct in the "these rules will bite if the runner changes" sense — Iddo has already decided banner shows whenever rules exist; if runner turns out to be Docker Desktop, ask him whether to add runner context to the banner copy or Sentry extra, don't decide unilaterally).
2. **Profile scoping**: a Block rule scoped `Public` doesn't apply while the vEthernet (WSL) adapter is classified `Private` (check `Get-NetConnectionProfile`). His rules are `Private, Public` so this shouldn't apply here — verify anyway.
3. **Wrong-port testing**: his wget probe targeted 47891 and got **refused** — if the app is actually on 47892+ (port race with a resident second instance), the browser flow (which uses the *correct* propagated port via `process.env.PORT`) works fine while manual probes at 47891 fail. This reconciles #2a and #2b **without any firewall involvement**.

---

## 5. Mystery #1 — no banner despite 3 Block rules (PR build installed)

### §5.0 Ground truth first (explains most things)

```powershell
# How many app processes? (also check tray — Electron apps keep running when the window closes)
tasklist | findstr /i gamut

# What is the app ACTUALLY listening on?
Get-Process Gamut -ErrorAction SilentlyContinue | ForEach-Object Id | ForEach-Object { Get-NetTCPConnection -State Listen -OwningProcess $_ -ErrorAction SilentlyContinue } | Select-Object LocalAddress, LocalPort -Unique

# Which exe is running (must equal the path in the Block rules)?
Get-Process Gamut -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique
```

Fully quit via tray icon → Quit (not just window close), confirm `tasklist` shows nothing, relaunch the PR build, re-check. **Use the discovered port in every command below.**

### Hypotheses, ranked, with tests

**H1 — stale process / stale cache.** Server detection cache = 5 min; renderer refetch = 5 min; a tray-resident pre-rule process serves stale status. *Test:* after a genuine full restart, hit the route directly, bypassing both caches:
```powershell
curl.exe -s "http://127.0.0.1:<PORT>/api/firewall/status?refresh=1"
```
Expected if healthy: `{"supported":true,"blocked":true,"blockRuleNames":["gamut.exe","gamut.exe","gamut.exe"],...}`. If this returns `blocked:true` but the sidebar shows nothing → renderer-side bug (H2). If `blocked:false` → detection-side bug (H3/H4). If non-200/hangs → route/auth problem, investigate response body.

**H2 — hook hides the banner on error.** `useFirewallStatus` throws on `!res.ok` → React Query error → `firewallStatus` undefined → banner silently hidden. *Test:* DevTools (if openable) network tab for `/api/firewall/status`, or compare H1's direct result vs UI. *Fix if confirmed:* keep last-known data / add `retry` + surface errors, and consider capturing hook-level failures.

**H3 — PowerShell quoting mangles the detection script.** Detection passes a multi-line script with embedded double quotes (`"$($_.Action)"`) via `powershell -Command` through Node's Windows arg-escaping. If quotes get stripped, the script errors → empty stdout → `JSON.parse` throws → `captureException` + `blocked:false` (fail-safe eats it). *Test:* Sentry should contain a `component:firewall / operation:detect` **exception** (not the "is blocking" message) around each app launch on this machine — ask Iddo to check https://datawizz.sentry.io (query `firewall`, last 24h), or check whether error reporting is even enabled in the app's settings. *Fix if confirmed (recommended hardening regardless):* write the detection script to a temp file and run `-File` (exactly like `fixScript` already does) — eliminates the whole `-Command` quoting class. Keep the Zod/fail-safe behavior.

**H4 — `-Program` filter mismatch inside the app.** The app queries `Get-NetFirewallApplicationFilter -Program <process.execPath>`. Iddo's manual query used `$env:LOCALAPPDATA\Programs\Gamut\Gamut.exe` and found the rules — but confirm the running exe path is byte-identical (H5.0 third command). Path-case differences *should* be fine (verify once from a PowerShell using the exact running path).

**H5 — detection exec fails entirely** (`powershell.exe` resolution from the packaged app's PATH). Would also land in Sentry as `operation:detect` exception. Same test as H3.

Whichever hypothesis is confirmed: fix on the #465 branch with a unit test pinning it, push, and note it on the PR.

---

## 6. Mystery #2 — `Connection refused` + browser-works-despite-block

- `wget … http://172.24.27.184:47891/... → Connection refused` (instant) = **no listener at that ip:port**; a firewall drop would hang ~5s and report timeout. So: wrong port (race → app on 47892+; §5.0 finds it), app not running at that moment, or wrong gateway IP for the distro that matters.
- Once the real port is known, redo the probe (curl is absent — use busybox wget):
```powershell
wsl -d superagent -- wget -q -O - -T 5 http://<GATEWAY_IP>:<REAL_PORT>/api/auth-config
```
  - **Timeout** → firewall genuinely blocking WSL→host → consistent with Block rules; then "browser works" must be explained by runner (§4.1) — check which runner the app is configured to use.
  - **JSON** → WSL→host is open despite Block rules → check profile scoping (§4.2) and whether the Allow rule from the earlier Fix click still exists and something is off in Block-beats-Allow assumptions (it shouldn't be — Block wins; if you observe otherwise, document precisely, that would be genuinely new information).
  - **Refused again** → still wrong port/IP; `Get-NetIPAddress -InterfaceAlias "vEthernet (WSL)*"` to cross-check the gateway IP from the host side.
- The deepest probe (exact production path, node exists in the container, curl doesn't):
```powershell
wsl -d superagent -- nerdctl ps --format "{{.Names}}"
wsl -d superagent -- nerdctl exec <NAME> node -e "fetch('http://host.docker.internal:<REAL_PORT>/api/auth-config').then(r=>console.log('OK',r.status)).catch(e=>console.log('FAIL',e.message))"
```

---

## 7. Validation matrix (finish line for both PRs)

### PR #465
- [ ] Mystery #1 resolved, root cause fixed + unit-tested, pushed.
- [ ] Block rules present → banner appears on fresh launch (use `?refresh=1` to skip caches while iterating).
- [ ] Sentry receives `component:firewall` detect message (ask Iddo to confirm in Sentry, or check `shareErrorReports`).
- [ ] Fix → UAC **decline** → banner shows "Approval was declined — an administrator must click Yes" + `Try again →`; no exception captured.
- [ ] Fix → UAC **accept** → banner clears without restart; `Get-NetFirewallApplicationFilter -Program "<exe>" | Get-NetFirewallRule` shows zero Block rows + one `Gamut agent connections / Inbound / Allow / Any`.
- [ ] WSL-side probe (busybox wget) now gets JSON; agent opens google.com via host Chrome end-to-end.
- [ ] Healthy-state regression: with no Block rules (and Hyper-V at its stock `Block`), **no banner** (`hyperVInboundBlock:true, blocked:false` in the status JSON).
- [ ] Cleanup: `Remove-NetFirewallRule -DisplayName "gamut.exe"` (removes the simulated ones — careful: if two of the three predate the test and Iddo wants his machine pristine, the app's Allow rule covers him anyway); decide with Iddo whether `"Gamut agent connections"` stays (recommended: yes).
- [ ] `npx tsc --noEmit`, targeted `npx vitest run src/main/windows-firewall/`, and the gated E2E on a dev checkout if feasible.
- [ ] Delete this handover file from the branch.

### PR #459
- [ ] Implement + unit-test the busybox-wget probe fallback (§3.2). Verify flags/stderr in the real distro FIRST.
- [ ] Force a CDP-only block (leave the app port reachable!):
```powershell
New-NetFirewallRule -DisplayName "TEST WSL CDP block" -Direction Inbound -Protocol TCP -LocalPort 49152-65535 -InterfaceAlias "vEthernet (WSL)" -Action Block
```
  (Win11 24H2 caveat: interface-alias rules may not bite WSL traffic — if the block doesn't reproduce, verify with a manual wget against the proxy port before concluding anything.)
- [ ] Browser Host = Google Chrome → agent opens a page → launch fails fast with the firewall message; Sentry `operation:cdp-proxy-reachability`; Chrome torn down (no orphan window).
- [ ] Remove rule → launch works.
- [ ] Also verify the container-side wraps: with the probe forced to `unknown` (e.g. temporarily rename wget+curl in the distro — or just rely on code review), a blocked `/json/version` or launch-POST yields the firewall-diagnosis message, not `fetch failed`.
- [ ] Cleanup: `Remove-NetFirewallRule -DisplayName "TEST WSL CDP block"`.

### CI note
`platform-auth-service.test.ts` "enriches env-managed status…" is a **proven flake**, not ours: branch run `29287194884` passed, `29293135790` failed with a disjoint diff (`fd56c147` touches only `src/main/windows-firewall/`), rerun of the same commit passed, main green 8×. Mechanism area: the memoized `/v1/account` introspection (main `9dcda7d9`) + process-global `fetch` spy vs file-scoped resets. File a separate small ticket; do NOT chase it inside these PRs.

---

## 8. Process rules (standing, from Iddo)

- **One fix at a time; stop after handing over each fix and wait for Iddo's explicit go.**
- Iddo normally commits himself; for these two branches he explicitly authorized pushing. Keep commits small and well-messaged; PR/commit messages may reference tickets, **code and test filenames must not contain issue IDs**.
- Never run `npm build` (kills dev server); typecheck `npx tsc --noEmit` (two pre-existing failures are known: `auth/index.ts` better-auth types, agent-container `render-prompt.ts` mustache — not yours); lint via `npx eslint`.
- `npm rebuild better-sqlite3` before running any tests. E2E output through `tee`.
- Zod-validate all JSON crossing process/file boundaries (pattern already in `firewall-schema.ts`).
- Never call a failing CI test flaky without run-history proof (see §7 CI note for the standard).

## 9. File map

| Area | Files |
|---|---|
| #465 detection/fix | `src/main/windows-firewall/{index,firewall-schema,windows-firewall.test}.ts` |
| #465 route | `src/api/routes/firewall.ts`, registered in `src/api/index.ts` |
| #465 renderer | `src/renderer/hooks/use-firewall-status.ts`, `src/renderer/components/runtime/runtime-status-banners.tsx` (`FirewallBlockedSidebarBanner`), `src/renderer/components/layout/app-sidebar.tsx` |
| #465 installer | `build/installer.nsh`, `package.json` (`build.nsis.include`) |
| #465 E2E | `e2e/specs/firewall-banner.spec.ts` (gated on `SUPERAGENT_FAKE_FIREWALL_BLOCK=1`) |
| #459 probe | `src/shared/lib/container/{types,base-container-client,wsl2-container-client,mock-container-client}.ts`, `wsl2-container-client.test.ts` |
| #459 provider gate | `src/main/host-browser/chrome-provider.ts`, `chrome-provider.sup217.test.ts` |
| #459 agent messages | `agent-container/src/server.ts` (~726 launch POST wrap, ~767 `/json/version` wrap) |

Cheat-sheet artifact from the original live call (commands, symptom→cause map): https://claude.ai/code/artifact/80d9a17c-6e47-40fc-8fe3-14a11badf27b
