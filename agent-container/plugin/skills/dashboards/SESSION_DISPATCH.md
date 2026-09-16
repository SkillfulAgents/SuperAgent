# Session Dispatch API

Dashboards can ask the app to start a new agent session with
`window.__GAMUT_DASHBOARD__.dispatchSession(...)`. This is how a dashboard adds
"do something with this row" actions — e.g. a **Research** button next to each
user in a table that kicks off a `/research-user` session.

**The app owns the actual dispatch.** Calling `dispatchSession` never starts a
session directly: the app shows the user a confirmation popup containing your
proposed prompt (which they can edit), and only creates the session if they
click **Dispatch**. The session always runs on the agent that owns this
dashboard — there is no way to target another agent. It runs in the
background; the user can open it from their session list.

## Quick start

```javascript
async function researchUser(user) {
  try {
    const result = await window.__GAMUT_DASHBOARD__.dispatchSession({
      prompt: `/research-user ${user.name} — company: ${user.company}, email: ${user.email}`,
      title: `Research ${user.name}`,
    });
    if (result.cancelled) return; // user dismissed the popup — not an error
    showToast(`Research started (session ${result.sessionId})`);
  } catch (err) {
    showToast(err.message); // dispatch unavailable or refused — do NOT retry in a loop
  }
}
```

## Request

`dispatchSession(request)` — `request` fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `prompt` | string | yes | The initial message for the new session, shown to the user prefilled and editable. Max 8000 chars. To invoke a skill, use its slash command as the message text: `"/my-skill arg1 arg2"`. |
| `title` | string | no | Title for the confirmation popup (e.g. `"Research Jane Doe"`). Max 200 chars. |

The session runs on the dashboard's own agent, so your prompt can rely on that
agent's skills and instructions.

## Result

Returns a Promise that stays pending while the popup is open (the user may take
as long as they like), then settles:

- **Resolves** `{ sessionId, agentSlug }` — the user confirmed; the session was
  created and is running in the background.
- **Resolves** `{ cancelled: true }` — the user dismissed the popup. Treat as a
  normal outcome, not an error.
- **Rejects** with an `Error` when the dispatch could not be offered:
  - `"Session dispatch is not available in this window"` — no host page is
    wrapping the dashboard. The in-app view, browser-tab popouts, and the
    desktop popout window all host dispatch; this only happens when the raw
    artifact URL is opened directly (nothing around the dashboard) or on an
    older app version. Disable or hide dispatch buttons gracefully in this
    case.
  - `"A dispatch request is already awaiting the user"` — a popup is already
    open. Only one request can be pending at a time.
  - `"Dispatch requests are rate limited — wait for the user"` — a request was
    just resolved; wait a couple of seconds before offering another.
  - A `TypeError` when `prompt` is missing or empty.

## Rules

- **Only call it from an explicit user action** (a button click). Never call it
  on load, on a timer, or in a loop — every call interrupts the user with a
  popup, and repeated calls are refused.
- **Never retry a rejection automatically.** Surface the message and let the
  user click again.
- **Write prompts that stand alone.** The session has no access to the
  dashboard's state — inline everything the agent needs (names, IDs, URLs)
  into the prompt text.
- **Handle unavailability.** Feature-detect with
  `typeof window.__GAMUT_DASHBOARD__?.dispatchSession === 'function'` and be
  prepared for the "not available in this window" rejection.

## Example: per-row action button (React)

```jsx
function UserRow({ user }) {
  const [state, setState] = useState('idle'); // idle | pending | done | error

  const research = async () => {
    setState('pending');
    try {
      const result = await window.__GAMUT_DASHBOARD__.dispatchSession({
        prompt: `/research-user ${user.name} (${user.email})`,
        title: `Research ${user.name}`,
      });
      setState(result.cancelled ? 'idle' : 'done');
    } catch {
      setState('error');
    }
  };

  return (
    <tr>
      <td>{user.name}</td>
      <td>
        <button onClick={research} disabled={state === 'pending'}>
          {state === 'done' ? 'Researching…' : 'Research'}
        </button>
      </td>
    </tr>
  );
}
```
