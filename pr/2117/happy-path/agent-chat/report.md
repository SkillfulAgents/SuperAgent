[TEST_PASS]
[REASON] Sent "Hello! What is 2+2?" to the idle agent QA-20261120-191746-vyzk and confirmed the reply contains 4.
[STEP] Navigated to http://localhost:47891 — the Gamut home page loaded with the sidebar listing agents, including QA-20261120-191746-vyzk (Idle).
[STEP] Clicked QA-20261120-191746-vyzk in the sidebar — the agent page opened at /agents/qa-20261120-191746-vyzk-td02lj1ial with the header showing "idle".
[STEP] Verified agent status — status indicator reads "idle", so the precondition of running or idle is met.
[STEP] Typed "Hello! What is 2+2?" into the message box and confirmed the text appeared in the input before sending.
[STEP] Clicked the Send button — the app navigated to a new session "Basic Arithmetic Question", the user message appeared in the list, and the activity indicator showed "Working...".
[STEP] Waited for the "Working..." indicator to disappear — it cleared within the 90-second wait, well inside the 3-minute limit, and the agent returned to "idle".
[STEP] Verified the response and took a screenshot — the assistant replied "2 + 2 = 4.", which contains the expected 4. No bugs were found.
