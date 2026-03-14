# In-Chat Request Cards

When the agent needs something from the user during a conversation, interactive request cards appear inline within the message list. There are two types: Secret Request and Question Request.

## Secret Request Card

**Location:** Appears inline in the chat message list when the agent needs a secret value (e.g., an API key or token).

**Container:** `data-testid='secret-request'`

### Components

- **Secret name label** — displays which secret the agent is requesting.
- **Value input field** — a text input where the user enters the secret value.
- **Provide button** (`data-testid='secret-provide-btn'`) — submits the entered value to the agent. Pressing Enter in the input field has the same effect.
- **Decline button** (`data-testid='secret-decline-btn'`) — refuses the request; the agent continues without the secret.

### States

- **Pending** — the card is interactive with the input field and both buttons enabled.
- **Completed** (`data-testid='secret-request-completed'`) — shown after the user provides a value or declines. The card becomes read-only and indicates the outcome.

### User Interactions

- Enter a value and provide it; the agent resumes with the secret available.
- Decline the request; the agent resumes and handles the missing secret gracefully.

---

## Question Request Card

**Location:** Appears inline in the chat message list when the agent asks the user a question.

**Container:** `data-testid='question-request'`

### Components

- **Question text** — the question the agent is asking.
- **Answer input** — varies by question type:
  - **Multiple-choice (single):** radio button options.
  - **Multiple-choice (multi):** checkbox options.
  - **Free-text:** a text input field.
- **Submit button** (`data-testid='question-submit-btn'`) — submits the selected/typed answer.
- **Decline button** (`data-testid='question-decline-btn'`) — refuses to answer; the agent continues without the response.

### States

- **Pending** — the card is interactive with answer input and both buttons enabled.
- **Completed** (`data-testid='question-request-completed'`) — shown after the user submits an answer or declines. The card becomes read-only and indicates the outcome.

### User Interactions

- Select an option or type a free-text answer and submit; the agent resumes with the answer.
- Decline the question; the agent resumes and handles the missing answer gracefully.
