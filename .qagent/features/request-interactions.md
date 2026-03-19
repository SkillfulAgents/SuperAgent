# Request Interactions

This feature covers in-chat Secret Request and Question Request cards, including submit/decline and completion states.

## Prerequisites

- Agent can trigger interactive request cards during chat.

## Chat View - Secret Request Card

### Components
- **Secret request container** (`data-testid='secret-request'`) - card wrapper.
- **Secret name label** - requested secret identifier.
- **Value input field** - user-entered secret value.
- **Provide button** (`data-testid='secret-provide-btn'`) - submits value.
- **Decline button** (`data-testid='secret-decline-btn'`) - declines request.
- **Completed state** (`data-testid='secret-request-completed'`) - read-only result state.

### Interactions
- Provide a secret value and verify card moves to completed state.
- Decline request and verify card moves to completed state.

## Chat View - Question Request Card

### Components
- **Question request container** (`data-testid='question-request'`) - card wrapper.
- **Question text** - prompt shown by agent.
- **Answer input** - radio/checkbox/free-text depending on question type.
- **Submit button** (`data-testid='question-submit-btn'`) - submits answer.
- **Decline button** (`data-testid='question-decline-btn'`) - declines answer.
- **Completed state** (`data-testid='question-request-completed'`) - read-only result state.

### Interactions
- Submit an answer and verify completed state.
- Decline question and verify completed state.

