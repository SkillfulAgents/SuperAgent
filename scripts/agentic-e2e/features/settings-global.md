# Global Settings Steps

## open-global-settings

Click the Settings button in the sidebar footer (data-testid='settings-button').
Assert: the global settings dialog opens (data-testid='global-settings-dialog').

---

## settings-nav-tab

In the global settings dialog, pick any tab in the left navigation and click it.
Take a screenshot.
Assert: the content area changes to show that tab's settings.
Try a few different tabs.

---

## verify-settings-tabs

Take a snapshot of the global settings dialog.
Assert: multiple tabs are visible in the left navigation (e.g. General, Notifications, LLM, etc).

---

## settings-set-api-key

**Skip this step** — API keys are pre-configured via the test runner's setup module.
Just verify the LLM tab shows the key status as already configured.

---

## settings-set-composio-key

**Skip this step** — Composio credentials are pre-configured via the test runner's setup module.
Just verify the Account Provider tab shows the key status as already configured.
