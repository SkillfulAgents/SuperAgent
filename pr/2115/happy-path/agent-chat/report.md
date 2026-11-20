[TEST_PASS]
[REASON] Sent "Hello! What is 2+2?" to the existing idle agent QA-20261120-191051-aznv and verified the assistant replied "2 + 2 = 4." within the 3-minute window.
[STEP] 1. Navigated to http://localhost:47891 — Gamut home loaded with the sidebar listing QA-20261120-191052-qk1r and QA-20261120-191051-aznv, no errors.
[STEP] 2. Clicked QA-20261120-191051-aznv in the sidebar — its agent page opened at /agents/qa-20261120-191051-aznv-o1mxlpnlxo.
[STEP] 3. Verified status — header shows "idle", matching the expected "running" or "idle".
[STEP] 4. Typed "Hello! What is 2+2?" into the agent message box and clicked Send — a new session "Basic Arithmetic Question Check" opened, showing the message and a "Working..." indicator.
[STEP] 5. Waited up to 3 minutes for the response — "Working..." cleared and the status returned to "idle" well within the limit.
[STEP] 6. Verified the response mentions 4 — the assistant replied "2 + 2 = 4." Screenshot taken (step6-response.png).
