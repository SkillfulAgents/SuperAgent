# Computer Use

Read this guide before continuing with native desktop interaction on macOS or
Windows. The user sees a visual halo around the grabbed application.

## Discover, Launch, and Grab

Use `computer_apps` to list running applications and `computer_windows` to list
open windows. Window results include stable refs such as `@w1` that can be
passed to `computer_grab`.

- Use `computer_launch(name)` when the application is not running. Launching
  automatically grabs its window.
- Use `computer_grab(app=...)` for the first window of a running application.
- Use `computer_grab(ref=...)` when a specific window matters.
- Always grab before click, fill, type, key, scroll, menu, or other interaction.

When the computer-use specialist is available, the parent agent launches or
grabs the application and delegates multi-step interaction. The parent retains
responsibility for final lifecycle decisions.

## Observe with Accessibility

`computer_launch` and `computer_grab` return an initial accessibility snapshot.
Read it before requesting another observation.

Use `computer_snapshot(interactive: true, compact: true)` as the primary
observation tool. It returns typed refs such as buttons, text fields, links,
dropdowns, and scroll areas. Re-snapshot after interactions that change the UI.

Use `computer_find` when the target text or role is known but the tree is large.
Use `computer_screenshot` only to verify pixel-level content—images, charts,
colors, or visual layout—that the accessibility tree cannot represent.

## Interact

- `computer_click` activates an element by ref and supports right/double click.
- `computer_fill` clears and replaces a specific text field; prefer it over a
  click/select-all/type sequence.
- `computer_type` appends text to the focused control.
- `computer_key` sends a key or combination such as `enter`, `tab`, `cmd+a`, or
  `escape`.
- `computer_select` chooses a dropdown value.
- `computer_scroll` scrolls the window or a specific scroll-area ref.
- `computer_menu("File > Save")` is generally more reliable than locating a
  toolbar button for standard application commands.
- `computer_dialog` detects, accepts, or cancels system dialogs.

Use `computer_run` only for operations without a dedicated tool, such as
reading a control value, hovering, dragging, waiting briefly, or inspecting the
clipboard.

Re-snapshot after every action that may change the active view or refs. Do not
reuse stale refs after navigation, dialogs, window changes, or substantial UI
updates.

## Authentication and Consequential Actions

When a login or authentication prompt appears, stop interaction and describe
what credentials or user action are needed so the parent can request user
input. Do not ask for passwords in ordinary chat.

Follow the system prompt's confirmation rules for sending messages, submitting
forms, changing settings, purchases, deletion, or other externally visible or
hard-to-reverse operations. Computer access does not imply authorization for
every action available in the application.

## Window Lifecycle

Call `computer_ungrab` when the interaction is complete so the halo is removed
and resources are released. Keep the window grabbed only while waiting for
immediate user input or while clearly mid-task.

Quit an application only when the user requested it or when the parent agent's
system guidance explicitly makes quitting part of the authorized lifecycle.
Do not force quit unless the user authorized it or the application is
unresponsive and closing it is necessary to complete the requested work.

## Validation

- Confirm the intended application and window before acting.
- Read back important field values when the application may reformat or reject
  input.
- Verify the visible postcondition after submissions or saves.
- Report dialogs, permissions, or unsupported accessibility controls instead
  of guessing coordinates or claiming completion.
