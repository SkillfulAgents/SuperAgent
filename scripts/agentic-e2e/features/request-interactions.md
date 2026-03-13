# Agent Request Interaction Steps

These steps test the interactive request cards that appear when an agent needs
something from the user (secret, question, MCP). To trigger these cards, you must
send specific chat messages that cause the agent to request resources.

Important: the agent MUST be running before these steps. If it is sleeping, start it first.

## trigger-secret-request

Send a chat message that would cause the agent to request a secret it doesn't have.
For example: "Please use my OPENAI_API_KEY to call the OpenAI API and list available models."
Wait for the agent to process. A secret request card should appear in the message list (data-testid='secret-request').
Take a screenshot.
Assert: a secret request card is visible, showing the secret name the agent is asking for.
DO NOT skip this step.

---

## provide-secret

Find the secret request card from the previous step.
Type any test value (e.g. "sk-test-12345") into the secret value input field.
Click the "Provide" button (data-testid='secret-provide-btn') or press Enter.
Take a screenshot.
Assert: the request card shows as completed (data-testid='secret-request-completed'), and the agent continues processing.

---

## trigger-and-decline-secret

Send another chat message that causes a secret request (e.g. "Use my GITHUB_TOKEN to authenticate with the GitHub API").
Wait for the secret request card to appear.
Click the "Decline" button (data-testid='secret-decline-btn').
Take a screenshot.
Assert: the request card shows as declined, and the agent continues (likely reporting it can't complete the task).

---

## trigger-question-request

Send a chat message that would cause the agent to ask you a question.
For example: "Help me set up a project. Ask me what programming language I want to use."
Wait for the agent to process. A question request card should appear (data-testid='question-request').
Take a screenshot.
Assert: a question request card is visible.
Note: if the agent answers directly without asking a question, try a different prompt like "I need help choosing — please ask me to pick between Python, JavaScript, or Rust."

---

## answer-question

Find the question request card.
If it is a multiple choice question, select any option.
If it is a free text question, type a reasonable answer (e.g. "Python").
Click the "Submit" button (data-testid='question-submit-btn').
Take a screenshot.
Assert: the question card shows as completed (data-testid='question-request-completed'), and the agent continues processing.

---

## trigger-and-decline-question

Trigger another question from the agent using a similar prompt.
When the question card appears, click the "Decline" button (data-testid='question-decline-btn').
Take a screenshot.
Assert: the question card shows as declined, and the agent continues.
If the agent doesn't ask a question, note it and move on.
