# Agent Secrets

This feature covers the standalone secrets page at `/agents/<slug>/secrets`.

## Prerequisites

- An agent exists and its detail page is open.
- The current user owns the agent when authentication mode is enabled.

## Secrets Page

### Components

- **Secrets card** (`data-testid='home-secrets-open-page'`) - opens the standalone page.
- **Back button** (`data-testid='secrets-back-button'`) - returns to the agent home.
- **Add Secret button** (`data-testid='secrets-add-button'`) - opens the add dialog.
- **Secret dialog** (`data-testid='secret-dialog'`) - creates or edits a secret.
- **Key input** (`data-testid='secret-dialog-key'`) - secret display name and env-var source.
- **Value input** (`data-testid='secret-dialog-value'`) - secret value.
- **Submit button** (`data-testid='secret-dialog-submit'`) - saves the change.
- **Secret row** (`data-testid='secret-row-<ENV_VAR>'`) - displays the key and env-var name.
- **Reveal button** (`data-testid='secret-reveal-<ENV_VAR>'`) - reveals or hides the value.
- **Row menu** (`data-testid='secret-menu-<ENV_VAR>'`) - opens edit and delete actions.

### Interactions

- Add a secret and verify its normalized environment-variable name.
- Reload the page and verify the secret persists.
- Reveal and hide a secret value.
- Rename a secret without revealing or replacing its stored value.
- Delete a secret and verify the row disappears.
- Verify invalid, duplicate, and reserved environment-variable names cannot be saved.
- Verify a non-owner sees the owner-access-required state without secret data.
