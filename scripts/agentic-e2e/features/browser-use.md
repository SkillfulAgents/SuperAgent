# Browser Use Steps

Test the agent's built-in browser tools (browser_open, browser_snapshot, browser_screenshot, browser_click, etc.).
These tools let the agent open a headless browser inside its container, navigate to websites, and interact with web pages.
The browser view is streamed live to the user in the UI.

Important: the agent MUST be running before these steps. If it is sleeping, start it first.

## verify-browser-settings

Open global settings (gear icon in sidebar footer).
Navigate to the "Browser Use" tab.
Take a screenshot.
Assert: the Browser Use settings tab is visible, showing options for Browser Agent Model and Browser Host (default: "Container (built-in)").
Close the settings dialog.

---

## browser-open-page

In the chat with the running agent, type the following message and press Enter:
"Open the website https://example.com in the browser and take a screenshot."
Wait for the agent to process — this may take 15-30 seconds as it opens the browser and navigates.
Watch for tool call cards in the message list:
- A "browser_open" tool call card should appear showing the URL
- A "browser_screenshot" tool call card should appear with a screenshot image
Take a screenshot of the chat showing the tool calls.
Assert: both tool call cards are visible, and the screenshot shows the example.com page.
DO NOT skip this step.

---

## browser-snapshot-and-interact

Send a follow-up message:
"Take a snapshot of the page and click the 'More information...' link on example.com."
Wait for the agent to process.
Watch for tool call cards:
- A "browser_snapshot" card showing the accessibility tree
- A "browser_click" card showing which element was clicked
Take a screenshot.
Assert: the agent used browser_snapshot to read the page and browser_click to interact with an element.
DO NOT skip this step.

---

## browser-search-and-extract

Send a message that requires the agent to navigate to a different site and extract information:
"Open https://en.wikipedia.org and search for 'Claude (AI)'. Take a screenshot of the search results."
Wait for the agent to process — this may take 30-60 seconds as it navigates and interacts.
Watch for tool call cards (browser_open, browser_fill, browser_click, browser_screenshot).
Take a screenshot.
Assert: the agent navigated to Wikipedia, interacted with the search form, and took a screenshot of the results.

---

## verify-browser-stream

While the agent is using browser tools (or after), check if a browser preview panel is visible in the UI.
The browser view should be streamed live — look for an iframe or image showing the browser content in the main content area.
Take a screenshot.
Assert: a browser preview is visible in the UI showing the current page the agent has open.
If no preview is visible (e.g. the browser was already closed), note the outcome.

---

## browser-close

Send a message: "Close the browser."
Wait for the agent to process.
Take a screenshot.
Assert: the agent confirms the browser is closed, and the browser preview (if any) disappears.
If the agent doesn't have a browser_close tool, it may say the browser closes automatically — that is acceptable.
