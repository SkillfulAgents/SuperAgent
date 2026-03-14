# Browser Use

## Global Settings — Browser Use Tab

Located in the global settings dialog (opened via the gear icon in the sidebar footer), the **Browser Use** tab contains configuration for the agent's browser capabilities.

### Components

- **Browser Agent Model** — selector for the model used when the agent performs browser interactions.
- **Browser Host** — dropdown to choose where the browser runs. The default value is "Container (built-in)".

## In-Chat Browser Tool Calls

When an agent uses browser tools during a conversation, **tool call cards** appear inline in the message list. Each card displays the tool name, the action performed, and any results.

### Tool Types

- **browser_open** — opens a URL in the headless browser. The card shows the target URL.
- **browser_screenshot** — captures a visual screenshot of the current page. The card displays the resulting image.
- **browser_snapshot** — captures the page's accessibility tree. The card shows the structured text output.
- **browser_click** — clicks an element on the page. The card indicates which element was targeted.
- **browser_fill** — fills a form field with text.
- **browser_close** — closes the browser session.

### User Interactions

- Users can scroll through tool call cards in the message list to follow the agent's browser activity step by step.
- Screenshot images within tool call cards can be viewed inline.

## Browser Preview Panel

A **live-streamed view** of the agent's browser session appears in the main content area while the browser is active. This is rendered as an iframe or image that updates in real time as the agent navigates and interacts with pages.

### Behavior

- The preview appears automatically when the agent opens a browser session.
- It reflects the current state of the page as the agent navigates, clicks, and fills forms.
- The preview disappears when the browser session is closed (either explicitly or automatically).
