In the normal course of an agent running, it may use the `AskUserQuestion` to ask the user a question that requires their input before proceeding. Typically these will be multiple choice questions, but can also allow for free text input.

I want to intercepr these tool calls similarly to how we handle the get secret and get oauth account tools -- when the agent calls this tool, we pause execution and surface the question to the user in the UI, allowing them to answer it. Once they answer, we resume the agent session with the answer provided.

In the UI, we should show the question(s), with mutliple choice options if provided, and/or a text input if free text is allowed. There should be a submit button to send the answer back to the agent.

Here's the structure for the tool call:

```typescript
interface AskUserQuestionInput {
  /**
   * Questions to ask the user (1-4 questions)
   */
  questions: Array<{
    /**
     * The complete question to ask the user. Should be clear, specific,
     * and end with a question mark.
     */
    question: string;
    /**
     * Very short label displayed as a chip/tag (max 12 chars).
     * Examples: "Auth method", "Library", "Approach"
     */
    header: string;
    /**
     * The available choices (2-4 options). An "Other" option is
     * automatically provided.
     */
    options: Array<{
      /**
       * Display text for this option (1-5 words)
       */
      label: string;
      /**
       * Explanation of what this option means
       */
      description: string;
    }>;
    /**
     * Set to true to allow multiple selections
     */
    multiSelect: boolean;
  }>;
  /**
   * User answers populated by the permission system.
   * Maps question text to selected option label(s).
   * Multi-select answers are comma-separated.
   */
  answers?: Record<string, string>;
}
```


And here's an example:
```json
{
  "questions": [
    {
      "question": "How should calendar invitations be handled? Some appear to be from real people but might be sales calls.",
      "header": "Invitations",
      "multiSelect": false,
      "options": [
        {
          "label": "Keep all calendar invitations unread (Recommended)",
          "description": "All emails with 'invitation' or meeting-related subjects stay unread, even if they might be sales-related."
        },
        {
          "label": "Mark invitation-style sales emails as read",
          "description": "Try to detect sales/outreach calendar invites and mark those as read, keep genuine internal meetings unread."
        }
      ]
    },
    {
      "question": "Should security-related notifications (Google security alerts, Vanta alerts, etc.) stay unread?",
      "header": "Security",
      "multiSelect": false,
      "options": [
        {
          "label": "Keep security alerts unread (Recommended)",
          "description": "All security, alert, and compliance notifications stay unread so you see them."
        },
        {
          "label": "Mark routine security notifications as read",
          "description": "Mark automated security notifications as read, focusing only on critical security issues."
        }
      ]
    }
  ]
}
```