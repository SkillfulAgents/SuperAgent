# Connected Accounts

This feature covers linking/unlinking accounts in settings and granting account access from in-chat request cards.

## Prerequisites

- At least one external account exists for add-flow validation.
- Agent settings dialog is accessible.

## Agent Settings - Accounts Tab

### Components
- **Connected accounts list** - linked accounts with remove icons.
- **Add accounts button** - opens account picker overlay.
- **Account picker** - checkbox list and add confirmation button.

### Interactions
- Add one or more accounts from picker.
- Verify accounts appear in connected list.
- Remove account and verify immediate removal.

## Chat View - Account Request Card

### Components
- **Account request card** - asks user to grant account access.
- **Account checkboxes** - selectable accounts to grant.
- **Grant Access button** - confirms grant and resumes agent flow.

### Interactions
- Trigger account request in chat.
- Select account and grant access.
- Verify card transitions to completed/granted state.

