[TEST_PASS]
[REASON] Opened agent QA-20261121-023221-cwf7, sent the browser task, and confirmed the reply names "Example Domain" as the page title.
[STEP] Step 1: Navigated to http://localhost:47891 — the Gamut app loaded (title "Gamut") with the sidebar listing "QA-20261121-023221-cwf7".
[STEP] Step 2: Clicked "QA-20261121-023221-cwf7" in the sidebar — the agent page opened at /agents/qa-20261121-023221-cwf7-n2hyyhp5ar, status "idle".
[STEP] Step 3: Typed "Open a browser and go to https://example.com. Tell me the page title." into the composer and pressed Enter — the text stayed in the composer and was not sent. I then clicked the Send button, and the message was sent. A new session "Check Example.com Page Title" started and showed "Working...".
[STEP] Step 4: Waited for the "Working..." indicator to disappear (up to 3 minutes) — it cleared in under a minute. The status changed to "idle" and the agent replied.
[STEP] Step 5: Verified the response reads 'The page title is "Example Domain". The browser has been closed again.' — the text matches. Took screenshot step5-response.png.

Observations (not counted as bugs):
- The composer placeholder says "Press cmd+enter to send", but a plain Enter did not send. This may be intended behaviour, since the Send button worked.
- The completed turn shows "3 tool calls" and a visible "ToolSearch" card. I did not expand the turn to check whether browser_open/browser_navigate cards appear, since that is beyond the scripted steps.
