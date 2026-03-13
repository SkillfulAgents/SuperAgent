# Connected Accounts Steps

## verify-account-in-agent-settings

Open the agent settings dialog (click the settings button in the agent header).
Click the "Accounts" tab.
Take a screenshot.
Assert: the connected accounts list is visible. It may show existing accounts (e.g. GitHub) or be empty.

---

## add-account-to-agent

In the agent settings dialog "Accounts" tab, click "Add accounts".
In the picker, check the checkbox for an available account (e.g. GitHub if it was set up).
Click the add button (e.g. "Add 1 account(s)").
Take a screenshot.
Assert: the account now appears in the agent's connected accounts list.
If no accounts are available to add, note "no accounts available" and move on.

---

## trigger-account-request-via-chat

To test the connected account request flow, the agent needs to request access to a connected account during chat.
Make sure the agent is running. Send a message that would require a connected account the agent doesn't have assigned yet.
For example: "Use my GitHub account to list my repositories" (if GitHub is not yet assigned to this agent).
Wait for the agent to process. A connected account request card should appear in the message list.
Take a screenshot.
Assert: a request card appears asking to grant access to a connected account (e.g. GitHub).
If no request card appears (agent may handle it differently), note the outcome and move on.

---

## grant-account-request

If a connected account request card appeared in the previous step:
Find the request card in the message list.
If existing accounts are listed, select one by clicking its checkbox.
Click the "Grant Access" button.
Take a screenshot.
Assert: the request card shows as completed/granted, and the agent continues processing.

---

## remove-account-from-agent

Open the agent settings dialog "Accounts" tab.
Find the account you added earlier in the list.
Click the remove (trash) icon next to it.
Take a screenshot.
Assert: the account is no longer in the agent's connected accounts list.
