# Browser Use

Read this guide before continuing with browser interaction. The browser is
visible to the user and preserves its profile, cookies, and login sessions.

## Choose the Browser Location

Call `browser_open` before interaction.

- Omit `location` to preserve the live browser's current location, or to use
  the configured provider when no browser is active.
- Use `location="container"` for dashboards, development servers, and private
  ports inside the agent container.
- Use `location="configured"` only when intentionally switching back to the
  user's configured external-site provider.

Switching locations closes the old browser. Never open a container-local
`localhost` URL in the host provider; it refers to the host's loopback
interface, not the agent container.

Use web search before opening a site when the exact URL is unknown. Do not
invent website URLs.

## Decide Whether to Delegate

When the web-browser specialist is available, delegate multi-step interaction
after opening the correct URL. Give it a concrete outcome, relevant constraints,
and any known destination. The parent agent owns `browser_open` and
`browser_close`; the specialist does not close the browser.

Direct browser interaction is appropriate for a small number of obvious steps,
for inspecting state around a delegation, or when browser subagents are not
available.

## Observe Efficiently

Use `browser_snapshot(interactive: true, compact: true)` for normal observation.
It returns actionable refs such as `@e1`.

Useful snapshot options:

- `scope`: restrict a large page to a form, dialog, or other CSS-selected
  region without invalidating refs elsewhere;
- `fullText: true`: include static text such as validation errors, prices,
  instructions, and toasts;
- `includeUrls: true`: inline link URLs when labels are ambiguous.

Use `browser_get_state` when the URL, screenshot, and accessibility snapshot
are all useful together. Use `browser_screenshot` only for pixel-level facts
that the accessibility tree cannot express, such as visual layout, charts,
images, or color.

Large snapshots may be truncated. Scope the next snapshot instead of repeatedly
requesting the same full page.

## Interact with Refs

Use the most specific tool:

- `browser_click` for buttons and links;
- `browser_fill` to clear and replace a normal input;
- `browser_type` for real keystrokes, append-only entry, payment iframes, OTP
  boxes, and controls that ignore `fill`;
- `browser_press` for one key or key combination, not for typing prose;
- `browser_select` for native `<select>` controls;
- `browser_hover` for hover menus and tooltips;
- `browser_scroll` for page or container scrolling.

Trust the action result. Click and key results report navigation; fill results
report the value the page actually committed. A fill warning means the page
kept a different value—fix it before moving on.

Navigation makes existing refs stale. Re-snapshot when a result reports
navigation, when a dialog or dynamic view changes the relevant controls, or
when fresh refs are otherwise needed. Do not re-snapshot merely to confirm a
successful action whose result already contains the confirmation.

For custom comboboxes, click the trigger, snapshot the opened list, interact
with the filter if present, and select using a fresh ref. Re-snapshot between
committed selections because refs may be renumbered.

## Tabs

Use `browser_run("tab")` to inspect stable tab IDs such as `t1` and `t2`.

- Do not exceed the tab limit reported by tool warnings.
- Reuse an existing tab instead of opening the same URL twice.
- Close duplicate and completed tabs promptly.
- Check tabs periodically during long workflows and after links that may open a
  new tab.
- Use stable string IDs; bare numeric tab indexes are not valid.

`browser_open` automatically switches to an existing tab with the same URL when
possible.

## Authentication and Sensitive Interaction

When a page requires login, CAPTCHA, 2FA, a passkey, or another step the user
must complete, immediately call
`mcp__user-input__request_browser_input`. Describe exactly what is visible and
what the user must do. After completion, snapshot the updated state.

Do not ask the user to paste credentials into chat. The browser profile retains
successful sessions. Follow the system prompt's confirmation rules for
submissions with financial, legal, destructive, or externally visible impact.

Cross-origin iframe content is unavailable to `browser_eval` and may not appear
as actionable snapshot fields. For embedded payment fields, click the iframe
field by the available mechanism and use `browser_type`.

## Uploads and Downloads

Use `browser_upload` on the actual `<input type="file">`. Do not click a visual
upload button that opens an operating-system picker. If the needed file is not
in the workspace, request it first with `mcp__user-input__request_file`.

Use `browser_download` for an actual file or image asset; do not substitute a
screenshot. Browser downloads are stored under `/workspace/downloads/`.
Report or deliver the saved path when the user needs the file.

## JavaScript and Advanced Commands

`browser_eval` runs in the top frame. Return `JSON.stringify(...)` for
structured output when needed. Prefer normal browser tools for interaction;
evaluation is useful for page-owned data or state that is difficult to access
semantically.

Use `browser_run` for advanced commands such as back, forward, reload, checkbox
toggle, tab management, console output, and browser errors. Pass pre-tokenized
arguments when any argument contains spaces or quotes.

## Dashboard and Local-App Validation

For a dashboard or development server:

1. Use the exact validation URL returned by its start tool.
2. Call `browser_open` with `location="container"`.
3. Inspect the rendered and accessibility state.
4. Exercise the primary controls and at least one important edge state.
5. Check `browser_run("errors")` and, when relevant,
   `browser_run("console")`.
6. Check server-side logs through the capability's own log tool.
7. Iterate until visual and functional checks pass.

Do not trim a dashboard's base path from its returned URL. A page looking
correct in a screenshot is not sufficient verification of interaction,
routing, or client-side behavior.

## Finish Cleanly

Close unneeded tabs during the task. When all browser work is complete, call
`browser_close` to release resources. If the browser must remain open because
the task is waiting for user input or an immediate continuation, say so.
