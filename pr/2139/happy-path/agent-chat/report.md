[TEST_PASS]
[REASON] Opened the Gamut app, selected agent QA-20261121-022944-98r7, confirmed it was idle, sent "Hello! What is 2+2?", and verified the reply mentions 4.
[STEP] Step 1, navigate to http://localhost:47891 — the Gamut home page loaded with the sidebar listing QA-20261121-022945-xyk7 and QA-20261121-022944-98r7, both idle.
[STEP] Step 2, click the "QA-20261121-022944-98r7" agent in the sidebar — the agent page opened at /agents/qa-20261121-022944-98r7-lo1wxzm6y1 with its name in the header.
[STEP] Step 3, verify status is "running" or "idle" — the status indicator on the agent page reads "idle". Screenshot taken.
[STEP] Step 4, send "Hello! What is 2+2?" — typed into the message box and pressed Enter, which did not submit (the box still showed the text and the Send button became enabled). Clicked the Send button, and the chat opened in session "Basic Arithmetic Greeting Check" with the user message shown once.
[STEP] Step 5, wait up to 3 minutes for a response — the reply appeared before any wait was needed; no explicit wait was performed.
[STEP] Step 6, verify the response mentions "4" and take a screenshot — the assistant reply reads "2 + 2 = 4.", the activity indicator is idle, and the screenshot was taken.

Note (not logged as a bug): plain Enter does not send from the first-message box. The placeholder says "Press cmd+enter to send", so this appears to be by design.
