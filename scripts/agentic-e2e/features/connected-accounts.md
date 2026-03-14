# Connected Accounts

## Agent Settings — Accounts Tab

Located inside the agent settings dialog, under the "Accounts" tab. This area manages which external accounts are available to the agent.

### Components

- **Connected accounts list** — displays all accounts currently linked to the agent. Each row shows the account name/provider and a **remove (trash) icon** for unlinking. The list may be empty if no accounts have been added yet.
- **"Add accounts" button** — opens an account picker overlay.

### Account Picker

Appears when the user activates "Add accounts". Presents available accounts that are not yet linked to this agent.

- **Account checkboxes** — one per available account, allowing multi-select.
- **Add button** — label reflects selection count (e.g. "Add 1 account(s)"). Confirms the selection and adds checked accounts to the agent's connected accounts list.
- If no accounts are available, the picker indicates that there are none to add.

### Removing an Account

Each account row in the connected accounts list includes a **remove (trash) icon**. Activating it unlinks the account, and it disappears from the list immediately.

---

## In-Chat Account Request Card

When the agent needs access to a connected account during a conversation, a **request card** appears inline in the message list.

### Components

- **Request card** (`data-testid`: refer to the message list for the card element) — a distinct card embedded in the chat timeline that communicates which account type the agent is requesting.
- **Account selection checkboxes** — if multiple accounts of the requested type exist, each is listed with a checkbox so the user can choose which to grant.
- **"Grant Access" button** — confirms the selection and provides the agent with the chosen account. After granting, the card transitions to a completed/granted state and the agent continues processing.
